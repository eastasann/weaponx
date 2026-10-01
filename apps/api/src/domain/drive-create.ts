import { LIMITS, linkKey, nameKey } from "@weaponx/shared";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { type CreatableKind, DriveError, type DriveFile } from "../drive";
import type { AppDeps } from "../lib/deps";
import { AppError, isUuid, validationFailed } from "../lib/errors";
import { FieldCollector } from "../lib/fields";
import { documentNotFound, requireDocumentAccess, requireSeriesAccess } from "./access";
import {
  assertReferencesAvailable,
  insertReferences,
  readChangeNote,
  readReferenceIds,
  referenceIdsOf,
  touchProject,
} from "./documents";
import { reauthRequired, requireActiveDrive } from "./drive";
import { type DbOrTx, requireProjectRole, shareLockProjectAndRequireRole } from "./projects";
import { getSeriesRow, getVersion, type SeriesRow, type Version } from "./series";

type Deps = Pick<AppDeps, "db" | "drive" | "logger">;

type Created = { series: SeriesRow; document: Version; editUrl: string };

/**
 * ドライブでの作成・コピーの呼び出し。認可エラーは連携を要再連携にして `DRIVE_REAUTH_REQUIRED`、
 * コピーで元のファイルを使えない・見つからないときは `DRIVE_SOURCE_UNAVAILABLE`、
 * そのほかの失敗は `DRIVE_CREATE_FAILED`(02-01 8章)。
 */
async function callDrive(
  deps: Deps,
  userId: string,
  kind: "create" | "copy",
  run: () => Promise<DriveFile>,
): Promise<DriveFile> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof DriveError)) throw error;
    if (error.reason === "reauth") throw await reauthRequired(deps, userId, error);
    if (kind === "copy" && error.reason === "not_accessible") {
      throw new AppError("DRIVE_SOURCE_UNAVAILABLE", { cause: error });
    }
    throw new AppError("DRIVE_CREATE_FAILED", { cause: error });
  }
}

/**
 * Drive に作れた後の登録の失敗を `DRIVE_CREATED_NOT_REGISTERED` にする(design-spec 6.0.8)。
 * 作ったファイルは消さない。登録までの間に案件が見つからなくなった・役割が足りなくなった
 * (404・403)は `not_found`・`forbidden`、それ以外は `internal`。
 */
async function registerCreated<T>(file: DriveFile, register: () => Promise<T>): Promise<T> {
  try {
    return await register();
  } catch (error) {
    const appError = error instanceof AppError ? error : undefined;
    const status = appError?.status;
    const cause = status === 404 ? "not_found" : status === 403 ? "forbidden" : "internal";
    throw new AppError("DRIVE_CREATED_NOT_REGISTERED", {
      status: cause === "internal" ? 500 : status,
      details: {
        file: { fileId: file.fileId, url: file.url },
        cause,
        causeCode: appError?.code ?? "INTERNAL",
      },
      cause: error,
    });
  }
}

/** Drive の応答の資料名・更新日時・種別で、作成・コピーした版の内容を決める(02-01 5.5) */
function createdFields(file: DriveFile) {
  return {
    name: file.name,
    nameKey: nameKey(file.name),
    url: file.url,
    linkKey: linkKey(file.url),
    kind: file.kind,
    googleFileId: file.fileId,
    sourceModifiedAt: file.modifiedAt,
    metadataFetchedAt: new Date(),
  };
}

/** 版の資料名(1〜200文字。design-spec 6.0.3)。不備は `fields.name` */
function readName(fields: FieldCollector, raw: string): string {
  return fields.text("name", raw, { max: LIMITS.documentName });
}

/**
 * ドライブでコピーできる版のファイル ID。ドキュメント・スライドで、ファイル ID を持つ版だけ
 * (02-01 5.7。それ以外はコピーする対象として画面に出さない)。
 */
function copyableFileId(field: string, doc: { kind: string; googleFileId: string | null }): string {
  if (doc.googleFileId !== null && (doc.kind === "google_doc" || doc.kind === "google_slides")) {
    return doc.googleFileId;
  }
  throw validationFailed({ [field]: "invalid_format" });
}

async function loadDocument(db: DbOrTx, documentId: string) {
  const [doc] = await db
    .select({
      id: t.documents.id,
      seriesId: t.documents.seriesId,
      kind: t.documents.kind,
      googleFileId: t.documents.googleFileId,
      deletedAt: t.documents.deletedAt,
    })
    .from(t.documents)
    .where(eq(t.documents.id, documentId));
  return doc;
}

/** 作成・コピーしたファイルを、案件の新しい系列の1版目として登録する(参考資料を添える) */
async function insertFirstVersion(
  tx: DbOrTx,
  userId: string,
  projectId: string,
  file: DriveFile,
  createdVia: "created" | "copied",
  referenceIds: string[],
): Promise<Created> {
  const [series] = await tx
    .insert(t.documentSeries)
    // 最初の版を1番にするので、次の番号は2から(ADR-013)
    .values({ projectId, nextVersionNo: 2 })
    .returning({ id: t.documentSeries.id });
  if (!series) throw new Error("系列の作成に失敗しました");
  const [document] = await tx
    .insert(t.documents)
    .values({
      ...createdFields(file),
      seriesId: series.id,
      projectId,
      versionNo: 1,
      createdVia,
      registeredBy: userId,
    })
    .returning({ id: t.documents.id });
  if (!document) throw new Error("版の登録に失敗しました");
  await insertReferences(tx, userId, document.id, referenceIds);
  await touchProject(tx, projectId);
  return {
    series: await getSeriesRow(tx, projectId, series.id),
    document: await getVersion(tx, series.id, document.id),
    editUrl: file.url,
  };
}

type NewDocumentInput = { kind: string; name: string; referenceIds?: string[] };

/** ドライブに空のドキュメント・スライドを作り、新しい系列の1版目にする(`POST .../documents/new`) */
export async function createDocument(
  deps: Deps,
  userId: string,
  projectId: string,
  input: NewDocumentInput,
): Promise<Created> {
  const { db } = deps;
  await requireProjectRole(db, userId, projectId, "editor");
  await requireActiveDrive(db, userId);
  const fields = new FieldCollector();
  const name = readName(fields, input.name);
  const referenceIds = readReferenceIds(fields, input.referenceIds ?? []);
  if (input.kind !== "google_doc" && input.kind !== "google_slides") {
    fields.reject("kind", "invalid_format");
  }
  fields.done();
  await assertReferencesAvailable(db, userId, referenceIds, null);

  const file = await callDrive(deps, userId, "create", () =>
    deps.drive.createFile(userId, input.kind as CreatableKind, name),
  );
  return registerCreated(file, () =>
    db.transaction(async (tx) => {
      await shareLockProjectAndRequireRole(tx, userId, projectId, "editor");
      await assertReferencesAvailable(tx, userId, referenceIds, null);
      return insertFirstVersion(tx, userId, projectId, file, "created", referenceIds);
    }),
  );
}

type CopyVersionInput = {
  sourceDocumentId: string;
  name: string;
  changeNote?: string | null;
};

/**
 * 系列の最新版をドライブでコピーし、同じ系列の次の版にする(`POST .../versions/copy`)。
 * 参考資料は、登録する時点の系列の最新版から引き継ぎ、タグは引き継がない(design-spec 6.3)。
 */
export async function copyVersion(
  deps: Deps,
  userId: string,
  seriesId: string,
  input: CopyVersionInput,
): Promise<Created> {
  const { db } = deps;
  const access = await requireSeriesAccess(db, userId, seriesId, "editor");
  await requireActiveDrive(db, userId);
  // コピー元は、入力の欄の検証より先に決める(別の系列の版は存在を漏らさず、見つからない版として扱う)
  if (!isUuid(input.sourceDocumentId))
    throw validationFailed({ sourceDocumentId: "invalid_format" });
  const source = await loadDocument(db, input.sourceDocumentId.toLowerCase());
  if (!source || source.seriesId !== access.seriesId || source.deletedAt) {
    throw documentNotFound(true);
  }
  const sourceFileId = copyableFileId("sourceDocumentId", source);
  const fields = new FieldCollector();
  const name = readName(fields, input.name);
  const changeNote = readChangeNote(fields, input.changeNote);
  fields.done();

  const file = await callDrive(deps, userId, "copy", () =>
    deps.drive.copyFile(userId, sourceFileId, name),
  );
  return registerCreated(file, () =>
    db.transaction(async (tx) => {
      await shareLockProjectAndRequireRole(tx, userId, access.projectId, "editor");
      const [numbered] = await tx
        .update(t.documentSeries)
        .set({ nextVersionNo: sql`${t.documentSeries.nextVersionNo} + 1` })
        .where(eq(t.documentSeries.id, access.seriesId))
        .returning({ versionNo: sql<number>`${t.documentSeries.nextVersionNo} - 1` });
      if (!numbered) throw documentNotFound(false);
      // 系列の行ロックを取った後の最新版。ダイアログを開いた後に新しい版が登録されていれば、その版
      const [latest] = await tx
        .select({ id: t.documents.id })
        .from(t.documents)
        .where(and(eq(t.documents.seriesId, access.seriesId), isNull(t.documents.deletedAt)))
        .orderBy(desc(t.documents.versionNo))
        .limit(1);
      if (!latest) throw documentNotFound(false);
      const referenceIds = await referenceIdsOf(tx, latest.id);

      const [document] = await tx
        .insert(t.documents)
        .values({
          ...createdFields(file),
          seriesId: access.seriesId,
          projectId: access.projectId,
          versionNo: numbered.versionNo,
          changeNote,
          createdVia: "copied",
          registeredBy: userId,
        })
        .returning({ id: t.documents.id });
      if (!document) throw new Error("版の登録に失敗しました");
      await insertReferences(tx, userId, document.id, referenceIds);
      await touchProject(tx, access.projectId);
      return {
        series: await getSeriesRow(tx, access.projectId, access.seriesId),
        document: await getVersion(tx, access.seriesId, document.id),
        editUrl: file.url,
      };
    }),
  );
}

type CopyDocumentInput = { targetProjectId: string; name: string };

/**
 * 版をドライブでコピーし、追加先の案件の新しい系列の1版目にする(`POST .../copies`)。
 * 参考資料にコピー元の版を記録し、タグは付けない(design-spec 6.3)。
 */
export async function copyDocument(
  deps: Deps,
  userId: string,
  documentId: string,
  input: CopyDocumentInput,
): Promise<Created & { projectId: string }> {
  const { db } = deps;
  const access = await requireDocumentAccess(db, userId, documentId, "editor");
  await requireActiveDrive(db, userId);
  const sourceDoc = await loadDocument(db, access.documentId);
  if (!sourceDoc) throw documentNotFound(false);
  const sourceFileId = copyableFileId("documentId", sourceDoc);
  const fields = new FieldCollector();
  const name = readName(fields, input.name);
  if (!isUuid(input.targetProjectId)) fields.reject("targetProjectId", "invalid_format");
  fields.done();

  // 追加先に追加できなくなった(削除された・編集者より下になった)ときは入力の問題(design-spec 6.0.8)
  const targetProjectId = input.targetProjectId.toLowerCase();
  try {
    await requireProjectRole(db, userId, targetProjectId, "editor");
  } catch (error) {
    if (error instanceof AppError && (error.status === 404 || error.status === 403)) {
      throw new AppError("TARGET_PROJECT_UNAVAILABLE", { cause: error });
    }
    throw error;
  }

  const file = await callDrive(deps, userId, "copy", () =>
    deps.drive.copyFile(userId, sourceFileId, name),
  );
  return registerCreated(file, () =>
    db.transaction(async (tx) => {
      await shareLockProjectAndRequireRole(tx, userId, targetProjectId, "editor");
      await assertReferencesAvailable(tx, userId, [sourceDoc.id], null);
      return {
        ...(await insertFirstVersion(tx, userId, targetProjectId, file, "copied", [sourceDoc.id])),
        projectId: targetProjectId,
      };
    }),
  );
}
