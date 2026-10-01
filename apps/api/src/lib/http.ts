import { randomUUID } from "node:crypto";
import type { FieldError } from "@weaponx/shared";
import { Elysia } from "elysia";
import { appendSetCookie } from "./cookies";
import type { AppDeps } from "./deps";
import { AppError, errorBody, isDbUnavailable, validationFailed } from "./errors";

/** リクエストごとの記録。ログと `X-Request-Id` で使う */
export type RequestState = {
  id: string;
  startedAt: number;
  userId?: string;
  errorCode?: string;
};

const states = new WeakMap<Request, RequestState>();

// LB が付ける `X-Cloud-Trace-Context: {32桁の16進}/{スパン};o={0|1}` の先頭がトレース ID(02-01 8章)
const TRACE_PATTERN = /^([0-9a-f]{32})(?:\/|;|$)/i;

export function requestState(request: Request): RequestState {
  let state = states.get(request);
  if (!state) {
    const trace = TRACE_PATTERN.exec(request.headers.get("x-cloud-trace-context") ?? "");
    state = {
      id: trace?.[1]?.toLowerCase() ?? randomUUID().replaceAll("-", ""),
      startedAt: performance.now(),
    };
    states.set(request, state);
  }
  return state;
}

/** 02-01 7章「セキュリティヘッダー」。API の応答は JSON だけなので画面向けの許可は最小限 */
const SECURITY_HEADERS: Record<string, string> = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self' https://apis.google.com",
    "frame-src https://docs.google.com https://drive.google.com https://accounts.google.com",
    "img-src 'self' data: https://*.googleusercontent.com",
    "frame-ancestors 'none'",
  ].join("; "),
};

const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/**
 * CSRF の確認(02-01 7章)。状態を変えるメソッドは `Origin` が `APP_ORIGIN` と一致し、
 * 本文があれば JSON であること。SameSite=Lax だけに頼らない。
 */
export function assertSameOrigin(request: Request, appOrigin: string): void {
  if (!MUTATING_METHODS.has(request.method)) return;
  if (request.headers.get("origin") !== appOrigin) throw new AppError("CSRF_REJECTED");
  if (
    request.body !== null &&
    !/^application\/json(\s*;|$)/i.test(request.headers.get("content-type") ?? "")
  ) {
    throw new AppError("CSRF_REJECTED");
  }
}

type ValidationIssue = { path: string; value?: unknown };

/** Elysia(TypeBox)の検証エラーを `VALIDATION_FAILED.details.fields` にする。値は返さない */
function fromSchemaError(error: { all?: ValidationIssue[] }): AppError {
  const fields: Record<string, FieldError> = {};
  for (const issue of error.all ?? []) {
    const key = issue.path.replace(/^\//, "").replaceAll("/", ".") || "body";
    fields[key] = issue.value === undefined ? "required" : "invalid_format";
  }
  return validationFailed(Object.keys(fields).length > 0 ? fields : { body: "invalid_format" });
}

/**
 * ログに出す例外の文字列。Drizzle のエラーは本文にクエリのパラメーター(資料名やリンク)を含むので、
 * 元になった DB のエラーだけを出す。
 */
export function safeStack(error: unknown, depth = 0): string | undefined {
  if (!(error instanceof Error) || depth > 3) return undefined;
  if (error.constructor.name === "DrizzleQueryError" && error.cause instanceof Error) {
    return error.cause.stack;
  }
  // `DRIVE_CREATED_NOT_REGISTERED` のように別のエラーを包んだときは、原因も残す
  const cause = safeStack(error.cause, depth + 1);
  return cause ? `${error.stack}\nCaused by: ${cause}` : error.stack;
}

function toAppError(error: unknown, code: string | number): AppError {
  if (error instanceof AppError) return error;
  if (code === "VALIDATION") return fromSchemaError(error as { all?: ValidationIssue[] });
  if (code === "PARSE") return validationFailed({ body: "invalid_format" });
  if (code === "NOT_FOUND") return new AppError("NOT_FOUND");
  if (isDbUnavailable(error)) return new AppError("SERVICE_UNAVAILABLE");
  return new AppError("INTERNAL");
}

/**
 * 全ルートに共通の処理: リクエスト ID、セキュリティヘッダー、CSRF、エラー応答の形式、リクエストのログ。
 * `onRequest` は全リクエスト(存在しないパスを含む)に効く。
 */
export function httpBase({ config, logger }: Pick<AppDeps, "config" | "logger">) {
  return new Elysia({ name: "http-base" })
    .onRequest(({ request, set }) => {
      const state = requestState(request);
      set.headers["x-request-id"] = state.id;
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) set.headers[name] = value;
      assertSameOrigin(request, config.appOrigin);
    })
    .onError({ as: "global" }, ({ error, code, set, request }) => {
      const state = requestState(request);
      const appError = toAppError(error, code);
      state.errorCode = appError.code;
      if (appError.status >= 500) {
        logger.error("unhandled error", {
          event: "unhandled_error",
          requestId: state.id,
          userId: state.userId,
          code: appError.code,
          stack_trace: safeStack(error),
        });
      }
      set.status = appError.status;
      for (const cookie of appError.cookies) appendSetCookie(set, cookie);
      return errorBody(appError);
    })
    .onAfterResponse({ as: "global" }, ({ request, set, route }) => {
      const state = requestState(request);
      const status = typeof set.status === "number" ? set.status : 200;
      const fields = {
        event: "request",
        requestId: state.id,
        userId: state.userId,
        // プレフィックス付きの `/` のルートは末尾にスラッシュが付くので、テンプレートから外す
        route: `${request.method} ${(route ?? "").replace(/(.)\/$/, "$1") || "unmatched"}`,
        status,
        durationMs: Math.round(performance.now() - state.startedAt),
        code: state.errorCode,
      };
      if (status >= 500) logger.error("request", fields);
      else if (status >= 400) logger.warn("request", fields);
      else logger.info("request", fields);
    });
}
