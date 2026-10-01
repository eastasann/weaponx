/** API のエラーコード(02-01 8章の表)。API は文言を返さず、画面がこの code で文言を選ぶ */
export const ERROR_CODES = [
  "UNAUTHENTICATED",
  "ACCOUNT_SUSPENDED",
  "CSRF_REJECTED",
  "ROLE_INSUFFICIENT",
  "ADMIN_REQUIRED",
  "PROJECT_NOT_FOUND",
  "DOCUMENT_NOT_FOUND",
  "MEMBER_NOT_FOUND",
  "NOT_FOUND",
  "VALIDATION_FAILED",
  "DUPLICATE_LINK",
  "REFERENCE_UNAVAILABLE",
  "TARGET_PROJECT_UNAVAILABLE",
  "LAST_OWNER",
  "LAST_ADMIN",
  "ALREADY_MEMBER",
  "USER_SUSPENDED",
  "EMAIL_TAKEN",
  "SELF_CHANGE_FORBIDDEN",
  "DRIVE_REAUTH_REQUIRED",
  "DRIVE_FILE_NOT_ACCESSIBLE",
  "DRIVE_SOURCE_UNAVAILABLE",
  "DRIVE_CREATE_FAILED",
  "DRIVE_CREATED_NOT_REGISTERED",
  "RATE_LIMITED",
  "INTERNAL",
  "SERVICE_UNAVAILABLE",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * 画面の振る舞いを決める分類(design-spec 6.0.2 の5分類)。
 * `session` は 6.0.7(セッション切れ)、`not_a_failure` は 6.0.9(失敗として扱わない)、
 * `created_not_registered` は 6.0.8 の扱い。
 */
export type ErrorCategory =
  | "not_found"
  | "forbidden"
  | "input"
  | "reauth"
  | "other"
  | "session"
  | "not_a_failure"
  | "created_not_registered";

const CATEGORY: Record<ErrorCode, ErrorCategory> = {
  UNAUTHENTICATED: "session",
  ACCOUNT_SUSPENDED: "forbidden",
  CSRF_REJECTED: "other",
  ROLE_INSUFFICIENT: "forbidden",
  ADMIN_REQUIRED: "forbidden",
  PROJECT_NOT_FOUND: "not_found",
  DOCUMENT_NOT_FOUND: "not_found",
  MEMBER_NOT_FOUND: "not_found",
  NOT_FOUND: "not_found",
  VALIDATION_FAILED: "input",
  DUPLICATE_LINK: "input",
  REFERENCE_UNAVAILABLE: "input",
  TARGET_PROJECT_UNAVAILABLE: "input",
  LAST_OWNER: "input",
  LAST_ADMIN: "input",
  ALREADY_MEMBER: "input",
  USER_SUSPENDED: "input",
  EMAIL_TAKEN: "input",
  SELF_CHANGE_FORBIDDEN: "input",
  DRIVE_REAUTH_REQUIRED: "reauth",
  DRIVE_FILE_NOT_ACCESSIBLE: "not_a_failure",
  DRIVE_SOURCE_UNAVAILABLE: "input",
  DRIVE_CREATE_FAILED: "other",
  DRIVE_CREATED_NOT_REGISTERED: "created_not_registered",
  RATE_LIMITED: "other",
  INTERNAL: "other",
  SERVICE_UNAVAILABLE: "other",
};

export function errorCategory(code: ErrorCode): ErrorCategory {
  return CATEGORY[code];
}

/** `DRIVE_CREATED_NOT_REGISTERED` は原因によって 500 / 404 / 403 になるので、ここでは 500(`internal`)を返す */
const STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  ACCOUNT_SUSPENDED: 401,
  CSRF_REJECTED: 403,
  ROLE_INSUFFICIENT: 403,
  ADMIN_REQUIRED: 403,
  PROJECT_NOT_FOUND: 404,
  DOCUMENT_NOT_FOUND: 404,
  MEMBER_NOT_FOUND: 404,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  DUPLICATE_LINK: 409,
  REFERENCE_UNAVAILABLE: 422,
  TARGET_PROJECT_UNAVAILABLE: 422,
  LAST_OWNER: 409,
  LAST_ADMIN: 409,
  ALREADY_MEMBER: 409,
  USER_SUSPENDED: 422,
  EMAIL_TAKEN: 409,
  SELF_CHANGE_FORBIDDEN: 422,
  DRIVE_REAUTH_REQUIRED: 409,
  DRIVE_FILE_NOT_ACCESSIBLE: 422,
  DRIVE_SOURCE_UNAVAILABLE: 422,
  DRIVE_CREATE_FAILED: 502,
  DRIVE_CREATED_NOT_REGISTERED: 500,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  SERVICE_UNAVAILABLE: 503,
};

export function errorStatus(code: ErrorCode): number {
  return STATUS[code];
}
