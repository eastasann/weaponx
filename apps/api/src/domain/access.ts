import { and, eq, isNull, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { AppError, parseUuid } from "../lib/errors";
import { type DbOrTx, type ProjectRole, requireProjectRole, roleAtLeast } from "./projects";

export const documentNotFound = (seriesExists: boolean) =>
  new AppError("DOCUMENT_NOT_FOUND", { details: { seriesExists } });

/** 形式が違う ID は存在しない ID と同じに扱う(存在するかどうかを形式で漏らさない) */
function documentUuid(value: string): string {
  try {
    return parseUuid(value, "DOCUMENT_NOT_FOUND");
  } catch {
    throw documentNotFound(false);
  }
}

export async function hasLiveVersion(db: DbOrTx, seriesId: string): Promise<boolean> {
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(t.documents)
    .where(and(eq(t.documents.seriesId, seriesId), isNull(t.documents.deletedAt)))
    .limit(1);
  return row !== undefined;
}

export type SeriesAccess = { seriesId: string; projectId: string; role: ProjectRole };

/**
 * 系列の ID で呼ぶ操作の認可(02-01 7章の判定の順)。系列が無い → `DOCUMENT_NOT_FOUND`、
 * 参加していない・案件が削除済み → `PROJECT_NOT_FOUND`、削除されていない版が無い →
 * `DOCUMENT_NOT_FOUND`、役割が足りない → `ROLE_INSUFFICIENT`。
 */
export async function requireSeriesAccess(
  db: DbOrTx,
  userId: string,
  seriesId: string,
  min: ProjectRole,
): Promise<SeriesAccess> {
  const id = documentUuid(seriesId);
  const [series] = await db
    .select({ projectId: t.documentSeries.projectId })
    .from(t.documentSeries)
    .where(eq(t.documentSeries.id, id));
  if (!series) throw documentNotFound(false);
  const role = await requireProjectRole(db, userId, series.projectId, "viewer");
  if (!(await hasLiveVersion(db, id))) throw documentNotFound(false);
  if (!roleAtLeast(role, min)) throw new AppError("ROLE_INSUFFICIENT");
  return { seriesId: id, projectId: series.projectId, role };
}

export type DocumentAccess = SeriesAccess & { documentId: string };

/**
 * 版の ID で呼ぶ操作の認可。判定の順は `requireSeriesAccess` と同じで、
 * 削除済みの版は `DOCUMENT_NOT_FOUND`(系列に削除されていない版が残っていれば `seriesExists: true`)。
 */
export async function requireDocumentAccess(
  db: DbOrTx,
  userId: string,
  documentId: string,
  min: ProjectRole,
): Promise<DocumentAccess> {
  const id = documentUuid(documentId);
  const [doc] = await db
    .select({
      seriesId: t.documents.seriesId,
      projectId: t.documents.projectId,
      deletedAt: t.documents.deletedAt,
    })
    .from(t.documents)
    .where(eq(t.documents.id, id));
  if (!doc) throw documentNotFound(false);
  const role = await requireProjectRole(db, userId, doc.projectId, "viewer");
  if (doc.deletedAt) throw documentNotFound(await hasLiveVersion(db, doc.seriesId));
  if (!roleAtLeast(role, min)) throw new AppError("ROLE_INSUFFICIENT");
  return { documentId: id, seriesId: doc.seriesId, projectId: doc.projectId, role };
}
