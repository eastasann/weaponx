import { nameKey } from "@weaponx/shared";
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { DriveError } from "../drive";
import type { AppDeps } from "../lib/deps";
import { reauthRequired, requireActiveDrive } from "./drive";
import { requireProjectRole } from "./projects";
import { modifiedAtOf } from "./series";

/** 10分以内に取得済みの版は取り直さない(02-01 5.5) */
const FRESH_MS = 10 * 60 * 1000;
/** Drive への同時の呼び出しの数 */
const CONCURRENCY = 5;
/** 1回に取り直す版の数 */
const MAX_TARGETS = 300;

/**
 * メタデータの取り直し(`POST /api/projects/:projectId/metadata-refresh`。design-spec 6.1)。
 * 表の最新版のうちドライブの資料で、呼んだ人のアプリが使えるものを Drive から取り直し、
 * 資料名・更新日時・種別を上書きして取得の記録を残す。使えない・取れない版はそのままにする。
 * 認可エラーなら連携を要再連携にして `DRIVE_REAUTH_REQUIRED`(それまでに取れた分は反映済み)。
 */
export async function refreshMetadata(
  deps: Pick<AppDeps, "db" | "drive" | "logger">,
  userId: string,
  projectId: string,
): Promise<{ updatedSeriesIds: string[] }> {
  const { db, drive } = deps;
  await requireProjectRole(db, userId, projectId, "viewer");
  await requireActiveDrive(db, userId);

  const latest = await db
    .selectDistinctOn([t.documents.seriesId], {
      id: t.documents.id,
      seriesId: t.documents.seriesId,
      googleFileId: t.documents.googleFileId,
      name: t.documents.name,
      kind: t.documents.kind,
      sourceModifiedAt: t.documents.sourceModifiedAt,
      createdAt: t.documents.createdAt,
      metadataFetchedAt: t.documents.metadataFetchedAt,
    })
    .from(t.documents)
    .where(and(eq(t.documents.projectId, projectId), isNull(t.documents.deletedAt)))
    .orderBy(t.documents.seriesId, desc(t.documents.versionNo));
  const staleBefore = Date.now() - FRESH_MS;
  const targets = latest
    .filter(
      (row): row is typeof row & { googleFileId: string } =>
        row.googleFileId !== null &&
        (row.metadataFetchedAt === null || row.metadataFetchedAt.getTime() < staleBefore),
    )
    .sort((a, b) => modifiedAtOf(b).getTime() - modifiedAtOf(a).getTime())
    .slice(0, MAX_TARGETS);

  const updated = new Set<string>();
  let reauth: DriveError | undefined;
  let next = 0;

  async function refreshOne(target: (typeof targets)[number]): Promise<void> {
    const fetchStartedAt = new Date();
    let file: Awaited<ReturnType<typeof drive.getFile>>;
    try {
      file = await drive.getFile(userId, target.googleFileId);
    } catch (error) {
      if (!(error instanceof DriveError)) throw error;
      // 使えない・一時的な失敗は、保存済みの値のままにして何も表示しない
      if (error.reason === "reauth") reauth = error;
      return;
    }
    const changed =
      target.metadataFetchedAt === null ||
      file.name !== target.name ||
      file.kind !== target.kind ||
      file.modifiedAt.getTime() !== (target.sourceModifiedAt?.getTime() ?? null);
    await db.transaction(async (tx) => {
      // 取得の間にリンクが変わった・削除された版、取得を始めた後に別の呼び出しが取得を記録した版
      // (その値のほうが新しい)は書かない
      const written = await tx
        .update(t.documents)
        .set({
          name: file.name,
          nameKey: nameKey(file.name),
          kind: file.kind,
          sourceModifiedAt: file.modifiedAt,
          metadataFetchedAt: fetchStartedAt,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(t.documents.id, target.id),
            eq(t.documents.googleFileId, target.googleFileId),
            isNull(t.documents.deletedAt),
            or(
              isNull(t.documents.metadataFetchedAt),
              lt(t.documents.metadataFetchedAt, fetchStartedAt),
            ),
          ),
        )
        .returning({ id: t.documents.id });
      if (written.length === 0) return;
      if (changed) updated.add(target.seriesId);
      if (file.modifiedAt.getTime() > modifiedAtOf(target).getTime()) {
        await tx
          .update(t.projects)
          .set({
            lastActivityAt: sql`greatest(${t.projects.lastActivityAt}, ${file.modifiedAt.toISOString()}::timestamptz)`,
          })
          .where(eq(t.projects.id, projectId));
      }
    });
  }

  async function worker(): Promise<void> {
    while (!reauth) {
      const target = targets[next++];
      if (!target) return;
      await refreshOne(target);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  if (reauth) throw await reauthRequired(deps, userId, reauth);
  return { updatedSeriesIds: [...updated] };
}
