import { and, eq } from "drizzle-orm";
import * as t from "../db/schema";
import { DriveError, type DriveFile } from "../drive";
import type { AppDeps } from "../lib/deps";
import { AppError, validationFailed } from "../lib/errors";
import type { DbOrTx } from "./projects";

export type DriveStatus = "active" | "needs_reauth";

/** 連携の行はログインした利用者には必ずある。無ければ許可を得ていないので、要再連携と同じに扱う(`GET /api/me` と同じ) */
export async function driveStatusOf(db: DbOrTx, userId: string): Promise<DriveStatus> {
  const [row] = await db
    .select({ status: t.driveConnections.status })
    .from(t.driveConnections)
    .where(eq(t.driveConnections.userId, userId));
  return row?.status ?? "needs_reauth";
}

/** 連携中だった利用者を要再連携にする。切り替わったときだけ `drive_reauth_required` を記録する */
async function markNeedsReauth(
  { db, logger }: Pick<AppDeps, "db" | "logger">,
  userId: string,
): Promise<void> {
  const changed = await db
    .update(t.driveConnections)
    .set({ status: "needs_reauth" })
    .where(and(eq(t.driveConnections.userId, userId), eq(t.driveConnections.status, "active")))
    .returning({ userId: t.driveConnections.userId });
  if (changed.length > 0) {
    logger.warn("drive connection needs reauth", { event: "drive_reauth_required", userId });
  }
}

/** Drive の認可エラーを受けたとき、連携を要再連携にして返す `DRIVE_REAUTH_REQUIRED`(02-01 8章) */
export async function reauthRequired(
  deps: Pick<AppDeps, "db" | "logger">,
  userId: string,
  cause: DriveError,
): Promise<AppError> {
  await markNeedsReauth(deps, userId);
  return new AppError("DRIVE_REAUTH_REQUIRED", { cause });
}

/** ドライブを使う処理の最初の確認。要再連携の人には Google を呼ばない(design-spec 6.0.5) */
export async function requireActiveDrive(db: DbOrTx, userId: string): Promise<void> {
  if ((await driveStatusOf(db, userId)) === "needs_reauth") {
    throw new AppError("DRIVE_REAUTH_REQUIRED");
  }
}

/**
 * ドライブのファイルの情報を取り、失敗は 02-01 8章のエラーにする。
 * 要再連携の人には Google を呼ばない。認可エラーなら連携の状態を要再連携に切り替える。
 */
export async function getDriveFile(
  deps: Pick<AppDeps, "db" | "drive" | "logger">,
  userId: string,
  fileId: string,
): Promise<DriveFile> {
  const { db, drive } = deps;
  await requireActiveDrive(db, userId);
  try {
    return await drive.getFile(userId, fileId);
  } catch (error) {
    if (!(error instanceof DriveError)) throw error;
    if (error.reason === "reauth") throw await reauthRequired(deps, userId, error);
    if (error.reason === "not_accessible") {
      throw new AppError("DRIVE_FILE_NOT_ACCESSIBLE", { details: { fileId }, cause: error });
    }
    throw new AppError("SERVICE_UNAVAILABLE", { cause: error });
  }
}

/**
 * 登録系の操作で、ドライブから資料名などを取り直す(02-01 5.5)。取り直せなくても失敗にせず、
 * `file` を空にして返す。呼び出し側は送られた値で登録を続け、`driveStatus` を応答に付ける。
 */
export async function tryGetDriveFile(
  deps: Pick<AppDeps, "db" | "drive" | "logger">,
  userId: string,
  fileId: string | null,
): Promise<{ file: DriveFile | null; driveStatus: DriveStatus }> {
  if (fileId === null) return { file: null, driveStatus: await driveStatusOf(deps.db, userId) };
  try {
    return { file: await getDriveFile(deps, userId, fileId), driveStatus: "active" };
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    if (error.code === "DRIVE_REAUTH_REQUIRED") return { file: null, driveStatus: "needs_reauth" };
    if (error.code === "DRIVE_FILE_NOT_ACCESSIBLE" || error.code === "SERVICE_UNAVAILABLE") {
      return { file: null, driveStatus: await driveStatusOf(deps.db, userId) };
    }
    throw error;
  }
}

/** 作成ダイアログを開いた時点の確認(02-01 5.7)。まだ使えないことは失敗にせず `accessible: false` で返す */
async function checkDriveAccess(
  deps: Pick<AppDeps, "db" | "drive" | "logger">,
  userId: string,
  fileId: string,
): Promise<{ accessible: boolean; fileId: string }> {
  try {
    await getDriveFile(deps, userId, fileId);
    return { accessible: true, fileId };
  } catch (error) {
    if (error instanceof AppError && error.code === "DRIVE_FILE_NOT_ACCESSIBLE") {
      return { accessible: false, fileId };
    }
    throw error;
  }
}

/** Google Picker 用の短命のトークン(02-01 5.7)。要再連携の人には Google を呼ばない */
export async function issuePickerToken(
  deps: Pick<AppDeps, "db" | "drive" | "logger">,
  userId: string,
): Promise<{ accessToken: string; expiresAt: string }> {
  const { db, drive } = deps;
  await requireActiveDrive(db, userId);
  try {
    const token = await drive.issuePickerToken(userId);
    return { accessToken: token.accessToken, expiresAt: token.expiresAt.toISOString() };
  } catch (error) {
    if (!(error instanceof DriveError)) throw error;
    if (error.reason === "reauth") throw await reauthRequired(deps, userId, error);
    throw new AppError("SERVICE_UNAVAILABLE", { cause: error });
  }
}

/**
 * 版のファイルをアプリが使えるか(`GET /api/documents/:documentId/drive-access`)。
 * ドキュメント・スライドでない版(ファイル ID が無い版を含む)は `VALIDATION_FAILED`。
 */
export async function documentDriveAccess(
  deps: Pick<AppDeps, "db" | "drive" | "logger">,
  userId: string,
  documentId: string,
): Promise<{ accessible: boolean; fileId: string }> {
  const [doc] = await deps.db
    .select({ kind: t.documents.kind, googleFileId: t.documents.googleFileId })
    .from(t.documents)
    .where(eq(t.documents.id, documentId));
  if (!doc?.googleFileId || (doc.kind !== "google_doc" && doc.kind !== "google_slides")) {
    throw validationFailed({ documentId: "invalid_format" });
  }
  return checkDriveAccess(deps, userId, doc.googleFileId);
}
