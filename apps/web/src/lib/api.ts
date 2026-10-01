import { treaty } from "@elysiajs/eden";
import type { App } from "../../../api/src/app";
import { ApiError, parseApiError, toApiError } from "./errors";

/** 同じオリジンの API(ADR-001)。開発では Vite のプロキシが `/api` を API へ渡す */
export const client = treaty<App>(window.location.origin);

type EdenResult<T> = {
  data: T | null;
  error: { status: unknown; value: unknown } | null;
  response: Response;
};

/** Eden の応答から値を取り出す。失敗は `ApiError` を投げる(ネットワークの切断を含む) */
export async function unwrap<T>(request: Promise<EdenResult<T>>): Promise<T> {
  let result: EdenResult<T>;
  try {
    result = await request;
  } catch (cause) {
    throw new ApiError("INTERNAL", { status: 0, cause });
  }
  if (result.error) {
    throw parseApiError(
      Number(result.error.status) || result.response.status,
      result.error.value,
      result.response.headers.get("x-request-id") ?? undefined,
    );
  }
  return result.data as T;
}

/**
 * 画面の想定外のエラーを API に送る(02-01 5.10)。ログイン画面・エラー画面からも送るので、
 * 失敗しても例外にしない。検索パラメーターは載せない(7章「ログ」)。
 */
export async function reportClientError(error: unknown): Promise<void> {
  const known = toApiError(error);
  const original = known.cause instanceof Error ? known.cause : error;
  const message = original instanceof Error ? original.message : String(original);
  const stack = original instanceof Error ? original.stack : undefined;
  try {
    await client.api["client-errors"].post({
      message,
      ...(stack ? { stack } : {}),
      path: window.location.pathname,
    });
  } catch {
    // 送れなくても、画面の表示は変えない
  }
}
