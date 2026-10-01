import type { DocumentKind } from "@weaponx/shared";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "../db/client";
import * as t from "../db/schema";
import { documentNotFound, requireSeriesAccess } from "./access";
import type { DbOrTx } from "./projects";

export type UserRef = { id: string; displayName: string | null; email: string };

/** 版(02-01 5.1「共通の型」) */
export type Version = {
  id: string;
  seriesId: string;
  projectId: string;
  versionNo: number;
  isLatest: boolean;
  name: string;
  kind: DocumentKind;
  url: string;
  googleFileId: string | null;
  modifiedAt: string;
  sourceModifiedAt: string | null;
  nameLocked: boolean;
  changeNote: string | null;
  tags: string[];
  registeredBy: UserRef;
  createdAt: string;
};

export type TagBadge = { label: string; versionNo: number | null };

export type SeriesRow = {
  id: string;
  latest: Version;
  olderCount: number;
  tags: TagBadge[];
  searchNames: string[];
};

/**
 * `referenceId` は参考資料の向き(`references`)の行にだけ付く。資料の ID ではなく、
 * 版の編集で引き継ぎ・取り消しの対象を指すための行の識別子(02-01 5.5)
 */
export type RelatedItem =
  | { visibility: "no_access"; referenceId?: string }
  | { visibility: "deleted"; referenceId?: string }
  | {
      visibility: "visible";
      documentId: string;
      seriesId: string;
      projectId: string;
      projectName: string | null;
      name: string;
      kind: DocumentKind;
      versionNo: number;
      isLatest: boolean;
      referencedVersionNo?: number | null;
    };

const versionColumns = {
  id: t.documents.id,
  seriesId: t.documents.seriesId,
  projectId: t.documents.projectId,
  versionNo: t.documents.versionNo,
  name: t.documents.name,
  kind: t.documents.kind,
  url: t.documents.url,
  googleFileId: t.documents.googleFileId,
  sourceModifiedAt: t.documents.sourceModifiedAt,
  metadataFetchedAt: t.documents.metadataFetchedAt,
  changeNote: t.documents.changeNote,
  registeredBy: t.documents.registeredBy,
  createdAt: t.documents.createdAt,
};

type VersionRow = {
  id: string;
  seriesId: string;
  projectId: string;
  versionNo: number;
  name: string;
  kind: DocumentKind;
  url: string;
  googleFileId: string | null;
  sourceModifiedAt: Date | null;
  metadataFetchedAt: Date | null;
  changeNote: string | null;
  registeredBy: string;
  createdAt: Date;
};

/** 版の更新日時。元の場所での更新日時が無ければ登録日時(02-01 6章「導出する値」) */
export const modifiedAtOf = (row: { sourceModifiedAt: Date | null; createdAt: Date }): Date =>
  row.sourceModifiedAt ?? row.createdAt;

function toVersion(
  row: VersionRow,
  registrant: UserRef,
  tags: string[],
  latestVersionNo: number,
): Version {
  return {
    id: row.id,
    seriesId: row.seriesId,
    projectId: row.projectId,
    versionNo: row.versionNo,
    isLatest: row.versionNo === latestVersionNo,
    name: row.name,
    kind: row.kind,
    url: row.url,
    googleFileId: row.googleFileId,
    modifiedAt: modifiedAtOf(row).toISOString(),
    sourceModifiedAt: row.sourceModifiedAt?.toISOString() ?? null,
    nameLocked: row.metadataFetchedAt !== null,
    changeNote: row.changeNote,
    tags,
    registeredBy: registrant,
    createdAt: row.createdAt.toISOString(),
  };
}

const registrantColumns = {
  registrantId: t.users.id,
  registrantName: t.users.displayName,
  registrantEmail: t.users.email,
};

const toUserRef = (r: {
  registrantId: string;
  registrantName: string | null;
  registrantEmail: string;
}): UserRef => ({ id: r.registrantId, displayName: r.registrantName, email: r.registrantEmail });

/**
 * 系列の一覧(02-01 5.5)。削除されていない版を1件以上持つ系列だけで、最新版の更新日時の新しい順。
 * 系列の数によらず、最新版・旧版の件数・資料名を1本(ウィンドウ関数)、タグを1本で取る(N+1 を作らない)。
 * `seriesIds` を渡すと、その系列だけにする(登録・編集の応答用)。
 */
export async function listSeriesRows(
  db: DbOrTx,
  projectId: string,
  seriesIds?: string[],
): Promise<SeriesRow[]> {
  if (seriesIds?.length === 0) return [];
  const scope = and(
    eq(t.documents.projectId, projectId),
    isNull(t.documents.deletedAt),
    seriesIds ? inArray(t.documents.seriesId, seriesIds) : undefined,
  );

  const ranked = db
    .select({
      ...versionColumns,
      rank: sql<number>`row_number() over (partition by ${t.documents.seriesId} order by ${t.documents.versionNo} desc)`.as(
        "rank",
      ),
      total: sql<number>`count(*) over (partition by ${t.documents.seriesId})`.as("total"),
      names: sql<
        string[]
      >`array_agg(${t.documents.name}) over (partition by ${t.documents.seriesId})`.as("names"),
    })
    .from(t.documents)
    .where(scope)
    .as("ranked");

  const latestRows = await db
    .select({
      id: ranked.id,
      seriesId: ranked.seriesId,
      projectId: ranked.projectId,
      versionNo: ranked.versionNo,
      name: ranked.name,
      kind: ranked.kind,
      url: ranked.url,
      googleFileId: ranked.googleFileId,
      sourceModifiedAt: ranked.sourceModifiedAt,
      metadataFetchedAt: ranked.metadataFetchedAt,
      changeNote: ranked.changeNote,
      registeredBy: ranked.registeredBy,
      createdAt: ranked.createdAt,
      total: ranked.total,
      names: ranked.names,
      ...registrantColumns,
    })
    .from(ranked)
    .innerJoin(t.users, eq(t.users.id, ranked.registeredBy))
    .where(eq(ranked.rank, 1));

  const tagRows = await db
    .select({
      documentId: t.documentTags.documentId,
      seriesId: t.documents.seriesId,
      versionNo: t.documents.versionNo,
      label: t.documentTags.label,
      labelKey: t.documentTags.labelKey,
      position: t.documentTags.position,
    })
    .from(t.documentTags)
    .innerJoin(t.documents, eq(t.documents.id, t.documentTags.documentId))
    .where(scope);

  const latestNo = new Map(latestRows.map((r) => [r.seriesId, r.versionNo]));
  const latestTags = new Map<string, { label: string; position: number }[]>();
  // 系列ごとに、タグ(label_key)が付いた版のうち最大の版番号の行だけを残す
  const badgeSource = new Map<string, Map<string, (typeof tagRows)[number]>>();
  for (const row of tagRows) {
    if (row.versionNo === latestNo.get(row.seriesId)) {
      const list = latestTags.get(row.documentId) ?? [];
      list.push({ label: row.label, position: row.position });
      latestTags.set(row.documentId, list);
    }
    const bySeries = badgeSource.get(row.seriesId) ?? new Map<string, (typeof tagRows)[number]>();
    const current = bySeries.get(row.labelKey);
    if (!current || current.versionNo < row.versionNo) bySeries.set(row.labelKey, row);
    badgeSource.set(row.seriesId, bySeries);
  }

  const rows = latestRows.map((row): SeriesRow => {
    const tags = (latestTags.get(row.id) ?? [])
      .sort((a, b) => a.position - b.position)
      .map((tag) => tag.label);
    const badges = [...(badgeSource.get(row.seriesId)?.values() ?? [])]
      .sort((a, b) => b.versionNo - a.versionNo || a.position - b.position)
      .map((tag) => ({
        label: tag.label,
        versionNo: tag.versionNo === row.versionNo ? null : tag.versionNo,
      }));
    return {
      id: row.seriesId,
      latest: toVersion(row, toUserRef(row), tags, row.versionNo),
      olderCount: row.total - 1,
      tags: badges,
      searchNames: row.names,
    };
  });
  return rows.sort(
    (a, b) =>
      Date.parse(b.latest.modifiedAt) - Date.parse(a.latest.modifiedAt) || a.id.localeCompare(b.id),
  );
}

export async function getSeriesRow(db: DbOrTx, projectId: string, seriesId: string) {
  const [row] = await listSeriesRows(db, projectId, [seriesId]);
  if (!row) throw documentNotFound(false);
  return row;
}

/** 系列の削除されていない版を新しい順に(タグは付けた順) */
async function listVersions(db: DbOrTx, seriesId: string): Promise<Version[]> {
  const rows = await db
    .select({ ...versionColumns, ...registrantColumns })
    .from(t.documents)
    .innerJoin(t.users, eq(t.users.id, t.documents.registeredBy))
    .where(and(eq(t.documents.seriesId, seriesId), isNull(t.documents.deletedAt)))
    .orderBy(desc(t.documents.versionNo));
  const tagRows =
    rows.length === 0
      ? []
      : await db
          .select({ documentId: t.documentTags.documentId, label: t.documentTags.label })
          .from(t.documentTags)
          .where(
            inArray(
              t.documentTags.documentId,
              rows.map((r) => r.id),
            ),
          )
          .orderBy(asc(t.documentTags.position));
  const tagsByDoc = new Map<string, string[]>();
  for (const tag of tagRows) {
    tagsByDoc.set(tag.documentId, [...(tagsByDoc.get(tag.documentId) ?? []), tag.label]);
  }
  const latestNo = rows[0]?.versionNo ?? 0;
  return rows.map((row) => toVersion(row, toUserRef(row), tagsByDoc.get(row.id) ?? [], latestNo));
}

/** 登録・編集の応答の `document`。削除されていない版でなければ `DOCUMENT_NOT_FOUND` */
export async function getVersion(db: DbOrTx, seriesId: string, documentId: string) {
  const version = (await listVersions(db, seriesId)).find((v) => v.id === documentId);
  if (!version) throw documentNotFound(true);
  return version;
}

const RELATED_ORDER = { sameProject: 0, otherProject: 1, no_access: 2, deleted: 3 } as const;

/** 同じ案件・他の案件・見る権限のない・削除された、の順。区分の中は名前順(画面が言語ごとに並べ直す) */
function sortRelated(items: RelatedItem[]): RelatedItem[] {
  const rank = (item: RelatedItem) =>
    item.visibility === "visible"
      ? item.projectName === null
        ? RELATED_ORDER.sameProject
        : RELATED_ORDER.otherProject
      : RELATED_ORDER[item.visibility];
  const name = (item: RelatedItem) => (item.visibility === "visible" ? item.name : "");
  return items.sort((a, b) => rank(a) - rank(b) || name(a).localeCompare(name(b)));
}

async function liveLatestNumbers(db: DbOrTx, seriesIds: string[]): Promise<Map<string, number>> {
  if (seriesIds.length === 0) return new Map();
  const rows = await db
    .select({
      seriesId: t.documents.seriesId,
      latest: sql<number>`max(${t.documents.versionNo})::int`,
    })
    .from(t.documents)
    .where(and(inArray(t.documents.seriesId, seriesIds), isNull(t.documents.deletedAt)))
    .groupBy(t.documents.seriesId);
  return new Map(rows.map((r) => [r.seriesId, r.latest]));
}

/** 選んだ版の参考資料(02-01 6章「関連資料の表示区分」)。見る権限のない・削除された資料は名前も ID も返さない */
async function listReferences(
  db: DbOrTx,
  userId: string,
  documentId: string,
  projectId: string,
): Promise<RelatedItem[]> {
  const rows = await db
    .select({
      referenceId: t.documentReferences.id,
      documentId: t.documents.id,
      seriesId: t.documents.seriesId,
      projectId: t.documents.projectId,
      projectName: t.projects.name,
      projectDeletedAt: t.projects.deletedAt,
      name: t.documents.name,
      kind: t.documents.kind,
      versionNo: t.documents.versionNo,
      deletedAt: t.documents.deletedAt,
      memberUserId: t.projectMembers.userId,
    })
    .from(t.documentReferences)
    .innerJoin(t.documents, eq(t.documents.id, t.documentReferences.referencedDocumentId))
    .innerJoin(t.projects, eq(t.projects.id, t.documents.projectId))
    .leftJoin(
      t.projectMembers,
      and(
        eq(t.projectMembers.projectId, t.documents.projectId),
        eq(t.projectMembers.userId, userId),
      ),
    )
    .where(eq(t.documentReferences.documentId, documentId));
  const latest = await liveLatestNumbers(
    db,
    rows.map((r) => r.seriesId),
  );
  return sortRelated(
    rows.map((row): RelatedItem => {
      if (row.memberUserId === null) {
        return { visibility: "no_access", referenceId: row.referenceId };
      }
      if (row.deletedAt || row.projectDeletedAt) {
        return { visibility: "deleted", referenceId: row.referenceId };
      }
      return {
        visibility: "visible",
        documentId: row.documentId,
        seriesId: row.seriesId,
        projectId: row.projectId,
        projectName: row.projectId === projectId ? null : row.projectName,
        name: row.name,
        kind: row.kind,
        versionNo: row.versionNo,
        isLatest: row.versionNo === latest.get(row.seriesId),
      };
    }),
  );
}

/**
 * この系列を参考にした資料(02-01 6章「導出する値」)。相手の系列ごとに1行にまとめ、
 * 行には相手の系列の最新版を出す。削除済みの版・案件は含めない。
 */
async function listReferencedBy(
  db: DbOrTx,
  userId: string,
  seriesId: string,
  projectId: string,
  liveVersionCount: number,
): Promise<RelatedItem[]> {
  const referenced = alias(t.documents, "referenced");
  const referencing = alias(t.documents, "referencing");
  const edges = await db
    .select({
      seriesId: referencing.seriesId,
      projectId: referencing.projectId,
      referencedVersionNo: referenced.versionNo,
    })
    .from(t.documentReferences)
    .innerJoin(
      referenced,
      and(
        eq(referenced.id, t.documentReferences.referencedDocumentId),
        eq(referenced.seriesId, seriesId),
        isNull(referenced.deletedAt),
      ),
    )
    .innerJoin(
      referencing,
      and(eq(referencing.id, t.documentReferences.documentId), isNull(referencing.deletedAt)),
    )
    .innerJoin(
      t.projects,
      and(eq(t.projects.id, referencing.projectId), isNull(t.projects.deletedAt)),
    );
  if (edges.length === 0) return [];

  const bySeries = new Map<string, { projectId: string; referencedVersionNo: number }>();
  for (const edge of edges) {
    const current = bySeries.get(edge.seriesId);
    if (!current || current.referencedVersionNo < edge.referencedVersionNo) {
      bySeries.set(edge.seriesId, edge);
    }
  }
  const otherSeriesIds = [...bySeries.keys()];
  const projectIds = [...new Set([...bySeries.values()].map((s) => s.projectId))];

  const latestRows = await db
    .select({
      id: t.documents.id,
      seriesId: t.documents.seriesId,
      name: t.documents.name,
      kind: t.documents.kind,
      versionNo: t.documents.versionNo,
      projectName: t.projects.name,
    })
    .from(t.documents)
    .innerJoin(t.projects, eq(t.projects.id, t.documents.projectId))
    .where(and(inArray(t.documents.seriesId, otherSeriesIds), isNull(t.documents.deletedAt)))
    .orderBy(desc(t.documents.versionNo));
  const latestOf = new Map<string, (typeof latestRows)[number]>();
  for (const row of latestRows) if (!latestOf.has(row.seriesId)) latestOf.set(row.seriesId, row);

  const memberOf = new Set(
    (
      await db
        .select({ projectId: t.projectMembers.projectId })
        .from(t.projectMembers)
        .where(
          and(eq(t.projectMembers.userId, userId), inArray(t.projectMembers.projectId, projectIds)),
        )
    ).map((m) => m.projectId),
  );

  return sortRelated(
    [...bySeries.entries()].flatMap(([otherSeriesId, edge]): RelatedItem[] => {
      if (!memberOf.has(edge.projectId)) return [{ visibility: "no_access" }];
      const latest = latestOf.get(otherSeriesId);
      if (!latest) return [];
      return [
        {
          visibility: "visible",
          documentId: latest.id,
          seriesId: otherSeriesId,
          projectId: edge.projectId,
          projectName: edge.projectId === projectId ? null : latest.projectName,
          name: latest.name,
          kind: latest.kind,
          versionNo: latest.versionNo,
          isLatest: true,
          referencedVersionNo: liveVersionCount >= 2 ? edge.referencedVersionNo : null,
        },
      ];
    }),
  );
}

export type SeriesDetail = {
  series: { id: string; projectId: string };
  selectedDocumentId: string;
  versions: Version[];
  references: RelatedItem[];
  referencedBy: RelatedItem[];
};

/** 横パネル(02-01 5.5)。`documentId` を省くと最新版。指定した版が削除済み・別の系列なら `DOCUMENT_NOT_FOUND` */
export async function getSeriesDetail(
  db: Db,
  userId: string,
  seriesId: string,
  documentId: string | undefined,
): Promise<SeriesDetail> {
  const access = await requireSeriesAccess(db, userId, seriesId, "viewer");
  const versions = await listVersions(db, access.seriesId);
  const selected = documentId ? versions.find((v) => v.id === documentId) : versions[0];
  if (!selected) throw documentNotFound(true);
  const [references, referencedBy] = await Promise.all([
    listReferences(db, userId, selected.id, access.projectId),
    listReferencedBy(db, userId, access.seriesId, access.projectId, versions.length),
  ]);
  return {
    series: { id: access.seriesId, projectId: access.projectId },
    selectedDocumentId: selected.id,
    versions,
    references,
    referencedBy,
  };
}
