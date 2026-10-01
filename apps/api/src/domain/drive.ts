import { eq } from "drizzle-orm";
import * as t from "../db/schema";
import { DriveError, type DriveFile } from "../drive";
import type { AppDeps } from "../lib/deps";
import { AppError } from "../lib/errors";
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

async function markNeedsReauth(db: DbOrTx, userId: string): Promise<void> {
  await db
    .update(t.driveConnections)
    .set({ status: "needs_reauth" })
    .where(eq(t.driveConnections.userId, userId));
}

/**
 * ドライブのファイルの情報を取り、失敗は 02-01 8章のエラーにする。
 * 要再連携の人には Google を呼ばない。認可エラーなら連携の状態を要再連携に切り替える。
 */
export async function getDriveFile(
  { db, drive }: Pick<AppDeps, "db" | "drive">,
  userId: string,
  fileId: string,
): Promise<DriveFile> {
  if ((await driveStatusOf(db, userId)) === "needs_reauth") {
    throw new AppError("DRIVE_REAUTH_REQUIRED");
  }
  try {
    return await drive.getFile(userId, fileId);
  } catch (error) {
    if (!(error instanceof DriveError)) throw error;
    if (error.reason === "reauth") {
      await markNeedsReauth(db, userId);
      throw new AppError("DRIVE_REAUTH_REQUIRED", { cause: error });
    }
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
  deps: Pick<AppDeps, "db" | "drive">,
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
