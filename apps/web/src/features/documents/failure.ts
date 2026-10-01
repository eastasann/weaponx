import type { QueryClient } from "@tanstack/react-query";
import { describeError, toApiError } from "../../lib/errors";
import type { Me } from "../../lib/queries";

/** 応答の `driveStatus` を連携の状態に反映する(02-01 5.5)。帯とダイアログの表示がここから決まる */
export function applyDriveStatus(queryClient: QueryClient, status: "active" | "needs_reauth") {
  queryClient.setQueryData<Me>(["me"], (me) => (me ? { ...me, drive: { status } } : me));
}

/** `DUPLICATE_LINK` の、すでにある資料(design-spec 6.0.4) */
export function duplicateOf(
  error: unknown,
): { seriesId: string; documentId: string; name: string } | null {
  const api = toApiError(error);
  if (api.code !== "DUPLICATE_LINK") return null;
  const existing = (
    api.details as { existing?: { seriesId: string; documentId: string; name: string } }
  )?.existing;
  return existing ?? null;
}

/** `REFERENCE_UNAVAILABLE` で外す参考資料の ID */
export function unavailableReferenceIds(error: unknown): string[] {
  const api = toApiError(error);
  if (api.code !== "REFERENCE_UNAVAILABLE") return [];
  return (api.details as { documentIds?: string[] } | undefined)?.documentIds ?? [];
}

export type CreatedNotRegistered = {
  fileId: string;
  url: string;
  /** `internal` は通信・その他。`not_found`・`forbidden` は確認の後、登録までの間に状態が変わった(design-spec 6.0.8) */
  cause: "internal" | "not_found" | "forbidden";
};

/** `DRIVE_CREATED_NOT_REGISTERED` の詳細。ドライブには作れたが登録に失敗したときの、作ったファイル */
export function createdNotRegistered(error: unknown): CreatedNotRegistered | null {
  const api = toApiError(error);
  if (api.code !== "DRIVE_CREATED_NOT_REGISTERED") return null;
  const details = api.details as
    | { file?: { fileId: string; url: string }; cause?: CreatedNotRegistered["cause"] }
    | undefined;
  if (!details?.file) return null;
  return { ...details.file, cause: details.cause ?? "internal" };
}

/**
 * ダイアログを閉じるべき失敗か(design-spec 6.0.2 の「見つからない」「権限がない」)。
 * セッション切れ・停止は `endsSession` が扱うので、ここでは閉じない
 */
export function closesDialog(error: unknown): boolean {
  const { category } = describeError(error);
  if (endsSession(error)) return false;
  return category === "not_found" || category === "forbidden";
}

/**
 * セッション切れ・停止。ログイン画面への送り出しは全体の処理が行うので、ダイアログは何も出さない
 * (design-spec 6.0.2 の停止「通知は出さない」、6.0.7)
 */
export function endsSession(error: unknown): boolean {
  const { code } = toApiError(error);
  return code === "UNAUTHENTICATED" || code === "ACCOUNT_SUSPENDED";
}
