import { type ErrorCode, errorStatus, type FieldError } from "@weaponx/shared";

/** `message` は開発者向けの英語で、画面には出さない(02-01 8章)。 */
const MESSAGES: Record<ErrorCode, string> = {
  UNAUTHENTICATED: "Authentication is required.",
  ACCOUNT_SUSPENDED: "This account is suspended.",
  CSRF_REJECTED: "The request origin or content type is not allowed.",
  ROLE_INSUFFICIENT: "Your role in this project does not allow this operation.",
  ADMIN_REQUIRED: "Administrator privileges are required.",
  PROJECT_NOT_FOUND: "The project was not found or you are not a member.",
  DOCUMENT_NOT_FOUND: "The document was not found.",
  MEMBER_NOT_FOUND: "The member was not found.",
  NOT_FOUND: "The resource was not found.",
  VALIDATION_FAILED: "The request contains invalid values.",
  DUPLICATE_LINK: "A document with the same link already exists in this project.",
  REFERENCE_UNAVAILABLE: "A selected reference is not available.",
  TARGET_PROJECT_UNAVAILABLE: "The target project cannot accept new documents.",
  LAST_OWNER: "A project must keep at least one owner.",
  LAST_ADMIN: "At least one active administrator is required.",
  ALREADY_MEMBER: "The user is already a member of this project.",
  USER_SUSPENDED: "The user is suspended.",
  EMAIL_TAKEN: "The email address is already registered.",
  SELF_CHANGE_FORBIDDEN: "Administrators cannot change their own account.",
  DRIVE_REAUTH_REQUIRED: "Google Drive authorization must be renewed.",
  DRIVE_FILE_NOT_ACCESSIBLE: "The file is not accessible to this app.",
  DRIVE_SOURCE_UNAVAILABLE: "The source file was not found or cannot be opened.",
  DRIVE_CREATE_FAILED: "Creating the file in Google Drive failed.",
  DRIVE_CREATED_NOT_REGISTERED: "The file was created in Google Drive but could not be registered.",
  RATE_LIMITED: "Too many requests.",
  INTERNAL: "An unexpected error occurred.",
  SERVICE_UNAVAILABLE: "A dependent service is temporarily unavailable.",
};

export type AppErrorOptions = {
  details?: Record<string, unknown>;
  /** 応答に付ける Set-Cookie(停止の通知のように、エラーと一緒に Cookie を返す場面) */
  cookies?: string[];
  cause?: unknown;
};

/** 02-01 8章のエラー。`code` から HTTP ステータスと文言を決める */
export class AppError extends Error {
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  readonly cookies: string[];

  constructor(
    readonly code: ErrorCode,
    options: AppErrorOptions = {},
  ) {
    super(MESSAGES[code], { cause: options.cause });
    this.status = errorStatus(code);
    this.details = options.details;
    this.cookies = options.cookies ?? [];
  }
}

export function validationFailed(fields: Record<string, FieldError>): AppError {
  return new AppError("VALIDATION_FAILED", { details: { fields } });
}

export function errorBody(error: AppError) {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    },
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** DB の uuid 型に渡す前の形式の確認。形式が違う ID は存在しない ID と同じに扱う */
export function parseUuid(value: string, notFound: ErrorCode): string {
  if (!UUID_PATTERN.test(value)) throw new AppError(notFound);
  return value.toLowerCase();
}

/**
 * postgres.js のエラー(`code` は SQLSTATE か接続エラーの名前)を探す。
 * Drizzle はクエリの失敗を `DrizzleQueryError` で包み、元のエラーを `cause` に入れる。
 */
function pgError(error: unknown): { code?: string; constraint_name?: string } | undefined {
  for (let current = error, depth = 0; current && depth < 3; depth++) {
    if (typeof current !== "object") return undefined;
    if (typeof (current as { code?: unknown }).code === "string") return current;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** 一意制約違反(23505)で、違反した制約が `constraint` か */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const pg = pgError(error);
  if (pg?.code !== "23505") return false;
  return !constraint || pg.constraint_name === constraint;
}

const UNAVAILABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
  "57P01", // admin_shutdown
  "57P03", // cannot_connect_now
]);

/** DB に一時的につながらないエラーか(`SERVICE_UNAVAILABLE` にする) */
export function isDbUnavailable(error: unknown): boolean {
  const code = pgError(error)?.code;
  return code !== undefined && (UNAVAILABLE_CODES.has(code) || code.startsWith("08"));
}
