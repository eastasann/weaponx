import {
  type DocumentKind,
  detectKind,
  LIMITS,
  linkKey,
  nameKey,
  parseDriveLink,
  type Tag,
  validateSingleLine,
  validateSourceModifiedAt,
  validateTags,
  validateUrl,
} from "@weaponx/shared";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import * as t from "../db/schema";
import type { DriveFile } from "../drive";
import type { AppDeps } from "../lib/deps";
import { AppError, isUniqueViolation, isUuid, validationFailed } from "../lib/errors";
import { FieldCollector } from "../lib/fields";
import {
  documentNotFound,
  hasLiveVersion,
  requireDocumentAccess,
  requireSeriesAccess,
} from "./access";
import { type DriveStatus, driveStatusOf, tryGetDriveFile } from "./drive";
import { type DbOrTx, shareLockProjectAndRequireRole } from "./projects";
import { getSeriesRow, getVersion, type SeriesRow, type Version } from "./series";

type Deps = Pick<AppDeps, "db" | "drive">;

/** 登録・編集の応答(02-01 5.5)。`driveStatus` は画面が連携の状態を更新するのに使う */
export type DocumentResult = { series: SeriesRow; document: Version; driveStatus: DriveStatus };

/** 参考資料の ID の並び。形式の不備は `invalid_format`、重複は1つにまとめ、件数は上限を超えれば `too_many` */
export function readReferenceIds(fields: FieldCollector, raw: readonly string[]): string[] {
  if (raw.some((id) => !isUuid(id))) {
    fields.reject("referenceIds", "invalid_format");
    return [];
  }
  const ids = [...new Set(raw.map((id) => id.toLowerCase()))];
  if (ids.length > LIMITS.referencesPerVersion) fields.reject("referenceIds", "too_many");
  return ids;
}

/** 変更メモ。空は「なし」(null) */
export function readChangeNote(
  fields: FieldCollector,
  raw: string | null | undefined,
): string | null {
  const note = fields.text("changeNote", raw ?? "", { max: LIMITS.changeNote, required: false });
  return note === "" ? null : note;
}

type LinkFields = {
  url: string;
  name: string;
  nameKey: string;
  kind: DocumentKind;
  sourceModifiedAt: Date | null;
  metadataFetchedAt: Date | null;
  googleFileId: string | null;
  linkKey: string;
};

type LinkInput = {
  url: string;
  name?: string;
  kind: DocumentKind;
  sourceModifiedAt?: string | null;
};

/** 送られた値で版の内容を決める(取り直せなかったとき、またはドライブの資料でないとき) */
function typedFields(
  fields: FieldCollector,
  url: string,
  input: LinkInput,
  drive: ReturnType<typeof parseDriveLink>,
): LinkFields {
  const name = fields.take(
    "name",
    validateSingleLine(input.name ?? "", { max: LIMITS.documentName }),
  );
  let sourceModifiedAt: Date | null = null;
  if (input.sourceModifiedAt != null) {
    const result = validateSourceModifiedAt(input.sourceModifiedAt);
    if (result.ok) sourceModifiedAt = result.value;
    else fields.reject("sourceModifiedAt", result.error);
  }
  return {
    url,
    name,
    nameKey: nameKey(name),
    kind: input.kind,
    sourceModifiedAt,
    metadataFetchedAt: null,
    googleFileId: drive?.googleFileId ?? null,
    linkKey: linkKey(url),
  };
}

function driveFields(url: string, file: DriveFile, drive: { googleFileId: string }): LinkFields {
  return {
    url,
    name: file.name,
    nameKey: nameKey(file.name),
    kind: file.kind,
    sourceModifiedAt: file.modifiedAt,
    metadataFetchedAt: new Date(),
    googleFileId: drive.googleFileId,
    linkKey: linkKey(url),
  };
}

/**
 * リンクで登録する版の内容を決める。ドライブの資料で取り直せれば、資料名・更新日時・種類は
 * ドライブの値を正とし、送られた値は見ない。取り直せなければ送られた値で続ける(02-01 5.5)。
 */
async function resolveLinkFields(
  deps: Deps,
  userId: string,
  fields: FieldCollector,
  input: LinkInput,
): Promise<{ link: LinkFields; driveStatus: DriveStatus }> {
  const urlResult = validateUrl(input.url);
  const url = fields.take("url", urlResult);
  if (!urlResult.ok) {
    // 欄の不備を1度で返せるよう、ほかの欄も調べてから失敗にする
    typedFields(fields, url, input, null);
    throw fields.failure() ?? validationFailed({ url: urlResult.error });
  }
  const drive = parseDriveLink(url);
  // ほかの欄がすでに不備なら、失敗する依頼のために Drive を呼ばない
  const { file, driveStatus } = await tryGetDriveFile(
    deps,
    userId,
    fields.failure() ? null : (drive?.googleFileId ?? null),
  );
  const link =
    drive && file ? driveFields(url, file, drive) : typedFields(fields, url, input, drive);
  return { link, driveStatus };
}

async function duplicateLink(
  db: DbOrTx,
  projectId: string,
  key: string,
  exceptDocumentId?: string,
): Promise<AppError | undefined> {
  const [existing] = await db
    .select({ seriesId: t.documents.seriesId, documentId: t.documents.id, name: t.documents.name })
    .from(t.documents)
    .where(
      and(
        eq(t.documents.projectId, projectId),
        eq(t.documents.linkKey, key),
        isNull(t.documents.deletedAt),
        exceptDocumentId ? ne(t.documents.id, exceptDocumentId) : undefined,
      ),
    );
  return existing ? new AppError("DUPLICATE_LINK", { details: { existing } }) : undefined;
}

/**
 * リンクの重複は部分一意インデックスが守る(ADR-013)。違反(23505)を `DUPLICATE_LINK` に変える。
 * 違反したトランザクションは中止されているので、既存の版の確認は外で行う。
 * 確認の前に相手の版が削除されていたら、重複ではなくなっているので1回だけやり直す。
 */
async function withDuplicateLink<T>(
  db: Db,
  projectId: string,
  key: string,
  exceptDocumentId: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (!isUniqueViolation(error, "documents_project_link_key")) throw error;
      const duplicate = await duplicateLink(db, projectId, key, exceptDocumentId);
      if (duplicate) throw duplicate;
      if (attempt > 0) throw error;
    }
  }
}

/**
 * 新しく選んだ参考資料の検証(design-spec 6.0.3)。参加している、削除されていない案件の、
 * 削除されていない版で、`seriesId` の系列の版でないこと。違反した ID は `details.documentIds` に返す。
 */
export async function assertReferencesAvailable(
  tx: DbOrTx,
  userId: string,
  ids: string[],
  seriesId: string | null,
): Promise<void> {
  if (ids.length === 0) return;
  const rows = await tx
    .select({ id: t.documents.id })
    .from(t.documents)
    .innerJoin(t.projects, eq(t.projects.id, t.documents.projectId))
    .innerJoin(
      t.projectMembers,
      and(eq(t.projectMembers.projectId, t.projects.id), eq(t.projectMembers.userId, userId)),
    )
    .where(
      and(
        inArray(t.documents.id, ids),
        isNull(t.documents.deletedAt),
        isNull(t.projects.deletedAt),
        seriesId ? ne(t.documents.seriesId, seriesId) : undefined,
      ),
    );
  const available = new Set(rows.map((r) => r.id));
  const unavailable = ids.filter((id) => !available.has(id));
  if (unavailable.length > 0) {
    throw new AppError("REFERENCE_UNAVAILABLE", { details: { documentIds: unavailable } });
  }
}

export async function referenceIdsOf(tx: DbOrTx, documentId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: t.documentReferences.referencedDocumentId })
    .from(t.documentReferences)
    .where(eq(t.documentReferences.documentId, documentId));
  return rows.map((r) => r.id);
}

export async function insertReferences(
  tx: DbOrTx,
  userId: string,
  documentId: string,
  ids: string[],
) {
  if (ids.length === 0) return;
  await tx
    .insert(t.documentReferences)
    .values(
      ids.map((referencedDocumentId) => ({ documentId, referencedDocumentId, createdBy: userId })),
    );
}

/** 案件の最終更新(02-01 6章)。ほかの書き込みが終わってから、トランザクションの最後に行う */
export async function touchProject(tx: DbOrTx, projectId: string): Promise<void> {
  await tx
    .update(t.projects)
    .set({ lastActivityAt: new Date() })
    .where(eq(t.projects.id, projectId));
}

/**
 * 版のタグを、送られた一式にする(02-01 6章 document_tags の規則)。無くなったタグは行を消し、
 * 残るタグは表記が変わったときだけ `label` を書き換え(`position` は保つ)、増えたタグは
 * 今の最大の `position` + 1 から送られた順に足す。
 */
async function replaceTags(tx: DbOrTx, userId: string, documentId: string, next: Tag[]) {
  const current = await tx
    .select({
      labelKey: t.documentTags.labelKey,
      label: t.documentTags.label,
      position: t.documentTags.position,
    })
    .from(t.documentTags)
    .where(eq(t.documentTags.documentId, documentId));
  const currentByKey = new Map(current.map((row) => [row.labelKey, row]));
  const nextKeys = new Set(next.map((tag) => tag.key));

  const removed = current.filter((row) => !nextKeys.has(row.labelKey)).map((row) => row.labelKey);
  if (removed.length > 0) {
    await tx
      .delete(t.documentTags)
      .where(
        and(eq(t.documentTags.documentId, documentId), inArray(t.documentTags.labelKey, removed)),
      );
  }
  for (const tag of next) {
    const existing = currentByKey.get(tag.key);
    if (existing && existing.label !== tag.label) {
      await tx
        .update(t.documentTags)
        .set({ label: tag.label })
        .where(
          and(eq(t.documentTags.documentId, documentId), eq(t.documentTags.labelKey, tag.key)),
        );
    }
  }
  let position = current.reduce((max, row) => Math.max(max, row.position), 0);
  const added = next.filter((tag) => !currentByKey.has(tag.key));
  if (added.length > 0) {
    await tx.insert(t.documentTags).values(
      added.map((tag) => ({
        documentId,
        labelKey: tag.key,
        label: tag.label,
        position: ++position,
        createdBy: userId,
      })),
    );
  }
}

type RegisterInput = LinkInput & { referenceIds?: string[] };

/** リンクで新しい系列を作り、その1版目として登録する(`POST /api/projects/:projectId/documents`) */
export async function registerDocument(
  deps: Deps,
  userId: string,
  projectId: string,
  input: RegisterInput,
): Promise<DocumentResult> {
  const { db } = deps;
  await shareLockProjectAndRequireRole(db, userId, projectId, "editor");
  const fields = new FieldCollector();
  const referenceIds = readReferenceIds(fields, input.referenceIds ?? []);
  const { link, driveStatus } = await resolveLinkFields(deps, userId, fields, input);
  fields.done();

  return withDuplicateLink(db, projectId, link.linkKey, undefined, () =>
    db.transaction(async (tx) => {
      await shareLockProjectAndRequireRole(tx, userId, projectId, "editor");
      await assertReferencesAvailable(tx, userId, referenceIds, null);
      const [series] = await tx
        .insert(t.documentSeries)
        // 最初の版を1番にするので、次の番号は2から(ADR-013)
        .values({ projectId, nextVersionNo: 2 })
        .returning({ id: t.documentSeries.id });
      if (!series) throw new Error("系列の作成に失敗しました");
      const [document] = await tx
        .insert(t.documents)
        .values({
          ...link,
          seriesId: series.id,
          projectId,
          versionNo: 1,
          createdVia: "link",
          registeredBy: userId,
        })
        .returning({ id: t.documents.id });
      if (!document) throw new Error("版の登録に失敗しました");
      await insertReferences(tx, userId, document.id, referenceIds);
      await touchProject(tx, projectId);
      return {
        series: await getSeriesRow(tx, projectId, series.id),
        document: await getVersion(tx, series.id, document.id),
        driveStatus,
      };
    }),
  );
}

type VersionInput = RegisterInput & { changeNote?: string | null };

/** 系列の次の版を登録する(`POST /api/series/:seriesId/versions`)。版番号は系列の行ロックで採番する(ADR-013) */
export async function registerVersion(
  deps: Deps,
  userId: string,
  seriesId: string,
  input: VersionInput,
): Promise<DocumentResult> {
  const { db } = deps;
  const access = await requireSeriesAccess(db, userId, seriesId, "editor");
  const fields = new FieldCollector();
  const referenceIds = readReferenceIds(fields, input.referenceIds ?? []);
  const changeNote = readChangeNote(fields, input.changeNote);
  const { link, driveStatus } = await resolveLinkFields(deps, userId, fields, input);
  fields.done();

  return withDuplicateLink(db, access.projectId, link.linkKey, undefined, () =>
    db.transaction(async (tx) => {
      await shareLockProjectAndRequireRole(tx, userId, access.projectId, "editor");
      const [numbered] = await tx
        .update(t.documentSeries)
        .set({ nextVersionNo: sql`${t.documentSeries.nextVersionNo} + 1` })
        .where(eq(t.documentSeries.id, access.seriesId))
        .returning({ versionNo: sql<number>`${t.documentSeries.nextVersionNo} - 1` });
      if (!numbered) throw documentNotFound(false);

      // 引き継いだ参考資料はそのまま受け付け、新しく足したものだけを検証する(design-spec 6.0.3)
      const [latest] = await tx
        .select({ id: t.documents.id })
        .from(t.documents)
        .where(and(eq(t.documents.seriesId, access.seriesId), isNull(t.documents.deletedAt)))
        .orderBy(desc(t.documents.versionNo))
        .limit(1);
      if (!latest) throw documentNotFound(false);
      const inherited = new Set(await referenceIdsOf(tx, latest.id));
      await assertReferencesAvailable(
        tx,
        userId,
        referenceIds.filter((id) => !inherited.has(id)),
        access.seriesId,
      );

      const [document] = await tx
        .insert(t.documents)
        .values({
          ...link,
          seriesId: access.seriesId,
          projectId: access.projectId,
          versionNo: numbered.versionNo,
          changeNote,
          createdVia: "link",
          registeredBy: userId,
        })
        .returning({ id: t.documents.id });
      if (!document) throw new Error("版の登録に失敗しました");
      await insertReferences(tx, userId, document.id, referenceIds);
      await touchProject(tx, access.projectId);
      return {
        series: await getSeriesRow(tx, access.projectId, access.seriesId),
        document: await getVersion(tx, access.seriesId, document.id),
        driveStatus,
      };
    }),
  );
}

export type UpdateInput = {
  url?: string;
  kind?: DocumentKind;
  name?: string;
  sourceModifiedAt?: string | null;
  changeNote?: string | null;
  tags?: string[];
  referenceIds?: string[];
};

/**
 * 登録内容の編集(`PATCH /api/documents/:documentId`)。送った項目だけを変える。
 * 版の行をロックしてから書くので、タグと参考資料の件数の上限は同時の編集でも守られる(ADR-013)。
 */
export async function updateDocument(
  deps: Deps,
  userId: string,
  documentId: string,
  input: UpdateInput,
): Promise<DocumentResult> {
  const { db } = deps;
  const access = await requireDocumentAccess(db, userId, documentId, "editor");
  const [before] = await db
    .select({ url: t.documents.url, metadataFetchedAt: t.documents.metadataFetchedAt })
    .from(t.documents)
    .where(eq(t.documents.id, access.documentId));
  if (!before) throw documentNotFound(false);

  const fields = new FieldCollector();
  const referenceIds =
    input.referenceIds === undefined ? undefined : readReferenceIds(fields, input.referenceIds);
  const changeNote =
    input.changeNote === undefined ? undefined : readChangeNote(fields, input.changeNote);
  let tags: Tag[] | undefined;
  if (input.tags !== undefined) {
    const result = validateTags(input.tags);
    if (result.ok) tags = result.value;
    else fields.reject("tags", result.error);
  }

  let url: string | undefined;
  if (input.url !== undefined) url = fields.take("url", validateUrl(input.url));
  const urlChanged = url !== undefined && url !== before.url;
  const drive = url ? parseDriveLink(url) : null;
  let fetched: { file: DriveFile; googleFileId: string } | null = null;
  let driveStatus: DriveStatus;
  if (urlChanged && drive && !fields.failure()) {
    const result = await tryGetDriveFile(deps, userId, drive.googleFileId);
    driveStatus = result.driveStatus;
    if (result.file) fetched = { file: result.file, googleFileId: drive.googleFileId };
  } else {
    driveStatus = await driveStatusOf(db, userId);
  }

  // 取得済みの版の資料名と更新日時は、リンクを変えない限り読み取り専用(design-spec 6.5.6)。
  // 形式の不備より `locked` を優先して返す。取り直せたときは Drive の値を使うので、送られた値の不備は問わない
  const readOnly = before.metadataFetchedAt !== null && !urlChanged;
  let name: string | undefined;
  if (input.name !== undefined) {
    const result = validateSingleLine(input.name, { max: LIMITS.documentName });
    if (readOnly) fields.reject("name", "locked");
    else if (result.ok) name = result.value;
    else if (!fetched) fields.reject("name", result.error);
  }
  let sourceModifiedAt: Date | null | undefined;
  if (input.sourceModifiedAt !== undefined) {
    const result =
      input.sourceModifiedAt === null
        ? ({ ok: true, value: null } as const)
        : validateSourceModifiedAt(input.sourceModifiedAt);
    if (readOnly) fields.reject("sourceModifiedAt", "locked");
    else if (result.ok) sourceModifiedAt = result.value;
    else if (!fetched) fields.reject("sourceModifiedAt", result.error);
  }
  fields.done();

  const apply = async (): Promise<DocumentResult> =>
    db.transaction(async (tx) => {
      await shareLockProjectAndRequireRole(tx, userId, access.projectId, "editor");
      const [current] = await tx
        .select()
        .from(t.documents)
        .where(eq(t.documents.id, access.documentId))
        // 参考資料とタグの行を書く間、同じ版の別の編集を待たせる。FK の共有ロックと衝突しないよう NO KEY
        .for("no key update");
      if (!current || current.deletedAt) {
        throw documentNotFound(await hasLiveVersion(tx, access.seriesId));
      }

      const changesUrl = url !== undefined && url !== current.url;
      // 読み込みの後に別の編集で取得済みになった場合に備えて、ロックの下でも確かめる
      if (current.metadataFetchedAt !== null && !changesUrl) {
        const locked = new FieldCollector();
        if (input.name !== undefined) locked.reject("name", "locked");
        if (input.sourceModifiedAt !== undefined) locked.reject("sourceModifiedAt", "locked");
        locked.done();
      }

      // 編集する項目が無くても、`updated_at` は書く(空の SET は書けない)
      const set: Partial<typeof t.documents.$inferInsert> = { updatedAt: new Date() };
      if (changeNote !== undefined) set.changeNote = changeNote;
      if (changesUrl && url !== undefined) {
        set.url = url;
        set.linkKey = linkKey(url);
        set.googleFileId = drive?.googleFileId ?? null;
        if (fetched && fetched.googleFileId === drive?.googleFileId) {
          set.name = fetched.file.name;
          set.nameKey = nameKey(fetched.file.name);
          set.kind = fetched.file.kind;
          set.sourceModifiedAt = fetched.file.modifiedAt;
          set.metadataFetchedAt = new Date();
        } else {
          set.metadataFetchedAt = null;
          set.kind = input.kind ?? detectKind(url);
        }
      } else if (input.kind !== undefined) {
        set.kind = input.kind;
      }
      if (!set.metadataFetchedAt) {
        if (name !== undefined) {
          set.name = name;
          set.nameKey = nameKey(name);
        }
        if (sourceModifiedAt !== undefined) set.sourceModifiedAt = sourceModifiedAt;
      }
      await tx.update(t.documents).set(set).where(eq(t.documents.id, current.id));

      if (referenceIds !== undefined) {
        const existing = new Set(await referenceIdsOf(tx, current.id));
        const next = new Set(referenceIds);
        const added = referenceIds.filter((id) => !existing.has(id));
        await assertReferencesAvailable(tx, userId, added, current.seriesId);
        const removed = [...existing].filter((id) => !next.has(id));
        if (removed.length > 0) {
          await tx
            .delete(t.documentReferences)
            .where(
              and(
                eq(t.documentReferences.documentId, current.id),
                inArray(t.documentReferences.referencedDocumentId, removed),
              ),
            );
        }
        await insertReferences(tx, userId, current.id, added);
      }
      if (tags !== undefined) await replaceTags(tx, userId, current.id, tags);
      await touchProject(tx, current.projectId);
      return {
        series: await getSeriesRow(tx, current.projectId, current.seriesId),
        document: await getVersion(tx, current.seriesId, current.id),
        driveStatus,
      };
    });

  if (url === undefined) return apply();
  return withDuplicateLink(db, access.projectId, linkKey(url), access.documentId, apply);
}

export type DeleteResult = { seriesRemoved: boolean; series: SeriesRow | null };

/**
 * 版を削除済みにする(`DELETE /api/documents/:documentId`)。元の場所のファイルには触れない。
 * 版番号は再利用しない(系列の `next_version_no` は戻さない)。
 */
export async function deleteDocument(
  db: Db,
  userId: string,
  documentId: string,
): Promise<DeleteResult> {
  const access = await requireDocumentAccess(db, userId, documentId, "editor");
  return db.transaction(async (tx) => {
    await shareLockProjectAndRequireRole(tx, userId, access.projectId, "editor");
    // 新しい版の登録(系列の行ロック)と直列にして、最後の1版の削除と登録が交差しないようにする
    await tx.execute(
      sql`select 1 from ${t.documentSeries} where ${t.documentSeries.id} = ${access.seriesId} for no key update`,
    );
    const [current] = await tx
      .select({ deletedAt: t.documents.deletedAt })
      .from(t.documents)
      .where(eq(t.documents.id, access.documentId))
      .for("no key update");
    if (!current || current.deletedAt) {
      throw documentNotFound(await hasLiveVersion(tx, access.seriesId));
    }
    await tx
      .update(t.documents)
      .set({ deletedAt: new Date(), deletedBy: userId })
      .where(eq(t.documents.id, access.documentId));
    await touchProject(tx, access.projectId);
    if (!(await hasLiveVersion(tx, access.seriesId))) {
      return { seriesRemoved: true, series: null };
    }
    return {
      seriesRemoved: false,
      series: await getSeriesRow(tx, access.projectId, access.seriesId),
    };
  });
}
