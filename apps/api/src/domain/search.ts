import { type DocumentKind, LIMITS, normalizeKey } from "@weaponx/shared";
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import * as t from "../db/schema";
import { requireProjectRole } from "./projects";
import { modifiedAtOf } from "./series";

/** LIKE のワイルドカードを文字として扱う(`\` で始まる ESCAPE 句と合わせる) */
const containsPattern = (key: string) => `%${key.replace(/[\\%_]/g, "\\$&")}%`;

const modifiedAtSql = sql`coalesce(${t.documents.sourceModifiedAt}, ${t.documents.createdAt})`;

/** 呼んだ人が参加している、削除されていない案件の、削除されていない版 */
const visibleVersions = (userId: string) =>
  and(
    isNull(t.documents.deletedAt),
    isNull(t.projects.deletedAt),
    eq(t.projectMembers.userId, userId),
  );

export type SearchResult = {
  documentId: string;
  seriesId: string;
  projectId: string;
  projectName: string;
  name: string;
  kind: DocumentKind;
  url: string;
  modifiedAt: string;
  isLatest: boolean;
};

/** 横断検索(design-spec 6.4)。資料名の部分一致で、更新日時の新しい順。上限を超えれば `truncated` */
export async function searchDocuments(
  db: Db,
  userId: string,
  query: string,
): Promise<{ results: SearchResult[]; truncated: boolean }> {
  const rows = await db
    .select({
      documentId: t.documents.id,
      seriesId: t.documents.seriesId,
      projectId: t.documents.projectId,
      projectName: t.projects.name,
      name: t.documents.name,
      kind: t.documents.kind,
      url: t.documents.url,
      sourceModifiedAt: t.documents.sourceModifiedAt,
      createdAt: t.documents.createdAt,
      isLatest: sql<boolean>`${t.documents.versionNo} = (
        select max(d2.version_no) from ${t.documents} d2
        where d2.series_id = ${t.documents.seriesId} and d2.deleted_at is null
      )`,
    })
    .from(t.documents)
    .innerJoin(t.projects, eq(t.projects.id, t.documents.projectId))
    .innerJoin(t.projectMembers, eq(t.projectMembers.projectId, t.projects.id))
    .where(
      and(
        visibleVersions(userId),
        sql`${t.documents.nameKey} like ${containsPattern(normalizeKey(query))} escape '\\'`,
      ),
    )
    .orderBy(desc(modifiedAtSql), t.documents.id)
    .limit(LIMITS.searchResults + 1);
  return {
    results: rows.slice(0, LIMITS.searchResults).map(({ sourceModifiedAt, createdAt, ...row }) => ({
      ...row,
      modifiedAt: modifiedAtOf({ sourceModifiedAt, createdAt }).toISOString(),
    })),
    truncated: rows.length > LIMITS.searchResults,
  };
}

export type ReferenceCandidate = {
  documentId: string;
  seriesId: string;
  projectId: string;
  projectName: string;
  name: string;
  kind: DocumentKind;
};

/**
 * 参考資料の候補(design-spec 6.2・6.5.5)。参加している案件の系列の最新版で、
 * `excludeSeriesId` の系列を除く。語が空なら更新日時の新しい順に並べる。
 */
export async function listReferenceCandidates(
  db: Db,
  userId: string,
  query: string,
  excludeSeriesId: string | undefined,
): Promise<ReferenceCandidate[]> {
  return db
    .select({
      documentId: t.documents.id,
      seriesId: t.documents.seriesId,
      projectId: t.documents.projectId,
      projectName: t.projects.name,
      name: t.documents.name,
      kind: t.documents.kind,
    })
    .from(t.documents)
    .innerJoin(t.projects, eq(t.projects.id, t.documents.projectId))
    .innerJoin(t.projectMembers, eq(t.projectMembers.projectId, t.projects.id))
    .where(
      and(
        visibleVersions(userId),
        sql`${t.documents.versionNo} = (
          select max(d2.version_no) from ${t.documents} d2
          where d2.series_id = ${t.documents.seriesId} and d2.deleted_at is null
        )`,
        excludeSeriesId ? ne(t.documents.seriesId, excludeSeriesId) : undefined,
        query === ""
          ? undefined
          : sql`${t.documents.nameKey} like ${containsPattern(normalizeKey(query))} escape '\\'`,
      ),
    )
    .orderBy(desc(modifiedAtSql), t.documents.id)
    .limit(LIMITS.candidates);
}

/**
 * タグの候補(02-01 6章 document_tags の規則)。案件の削除されていない版に付いているタグで、
 * 表記が違う同じタグ(Final と final)は最も新しく付けた行の表記を返す。
 */
export async function listTagCandidates(
  db: Db,
  userId: string,
  projectId: string,
  query: string,
): Promise<string[]> {
  await requireProjectRole(db, userId, projectId, "viewer");
  const rows = await db
    .selectDistinctOn([t.documentTags.labelKey], {
      labelKey: t.documentTags.labelKey,
      label: t.documentTags.label,
    })
    .from(t.documentTags)
    .innerJoin(t.documents, eq(t.documents.id, t.documentTags.documentId))
    .where(
      and(
        eq(t.documents.projectId, projectId),
        isNull(t.documents.deletedAt),
        query === ""
          ? undefined
          : sql`${t.documentTags.labelKey} like ${containsPattern(normalizeKey(query))} escape '\\'`,
      ),
    )
    .orderBy(t.documentTags.labelKey, desc(t.documentTags.createdAt))
    .limit(LIMITS.candidates);
  return rows.map((row) => row.label);
}
