import {
  ERROR_CODES,
  type ErrorCategory,
  type ErrorCode,
  errorCategory,
  type FieldError,
} from "@weaponx/shared";

/** API が返したエラー(02-01 8章)。ネットワークの切断など応答が無いものも `INTERNAL` として持つ */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;
  readonly requestId: string | undefined;

  constructor(
    code: ErrorCode,
    options: { status: number; details?: unknown; requestId?: string; cause?: unknown },
  ) {
    super(code, { cause: options.cause });
    this.name = "ApiError";
    this.code = code;
    this.status = options.status;
    this.details = options.details;
    this.requestId = options.requestId;
  }
}

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}

/**
 * 応答のステータスと本文から `ApiError` を作る。Cloud Armor の 429 は本文が JSON でない
 * ので、ステータスだけで `RATE_LIMITED` にする(02-01 8章)。
 */
export function parseApiError(status: number, body: unknown, requestId?: string): ApiError {
  const error = (body as { error?: { code?: unknown; details?: unknown } } | null)?.error;
  if (isErrorCode(error?.code)) {
    return new ApiError(error.code, { status, details: error.details, requestId });
  }
  if (status === 429) return new ApiError("RATE_LIMITED", { status, requestId });
  return new ApiError(status === 404 ? "NOT_FOUND" : "INTERNAL", { status, requestId });
}

/** 例外を `ApiError` にそろえる。想定外の例外とネットワークの切断は `INTERNAL`(02-01 8章) */
export function toApiError(error: unknown): ApiError {
  return error instanceof ApiError ? error : new ApiError("INTERNAL", { status: 0, cause: error });
}

export type ErrorDisplay = {
  category: ErrorCategory;
  code: ErrorCode;
  /** 翻訳ファイルのキー。`{{name}}` などの値は呼び出し側が渡す */
  messageKey: `errors.${ErrorCode}` | "errors.loadFailed";
};

/**
 * エラーを design-spec 6.0.2 の分類と文言のキーに当てはめる。読み込みの失敗(通信・その他)は
 * 「保存できませんでした」ではなく「読み込めませんでした」にする。
 */
export function describeError(error: unknown, mode: "read" | "write" = "write"): ErrorDisplay {
  const { code } = toApiError(error);
  const category = errorCategory(code);
  const messageKey: ErrorDisplay["messageKey"] =
    category === "other" && mode === "read" ? "errors.loadFailed" : `errors.${code}`;
  return { category, code, messageKey };
}

/** `VALIDATION_FAILED.details.fields` を欄の名前ごとの理由にする。該当しないエラーは空 */
export function fieldErrors(error: unknown): Record<string, FieldError> {
  const apiError = toApiError(error);
  if (apiError.code !== "VALIDATION_FAILED") return {};
  const fields = (apiError.details as { fields?: Record<string, FieldError> } | undefined)?.fields;
  return fields ?? {};
}
