import { describe, expect, test } from "bun:test";
import { appendSetCookie, clearCookie, readCookie, serializeCookie } from "./cookies";
import { AppError, errorBody, isDbUnavailable, isUniqueViolation, parseUuid } from "./errors";
import { assertSameOrigin, requestState } from "./http";
import { createLogger } from "./logger";

describe("cookies", () => {
  test("属性を付けて直列化し、削除は Max-Age=0", () => {
    expect(
      serializeCookie("a", "b", { maxAge: 60, httpOnly: true, secure: true, path: "/api/auth" }),
    ).toBe("a=b; Path=/api/auth; Max-Age=60; SameSite=Lax; HttpOnly; Secure");
    expect(clearCookie("a", { httpOnly: false, secure: false })).toBe(
      "a=; Path=/; Max-Age=0; SameSite=Lax",
    );
  });

  test("Cookie ヘッダーから名前で読む", () => {
    expect(readCookie("a=1; wx_session=tok=en; b=2", "wx_session")).toBe("tok=en");
    expect(readCookie("a=1", "wx_session")).toBeUndefined();
    expect(readCookie(null, "a")).toBeUndefined();
  });

  test("Set-Cookie は上書きせず並べる", () => {
    const set = { headers: {} as Record<string, unknown> };
    appendSetCookie(set, "a=1");
    appendSetCookie(set, "b=2");
    expect(set.headers["set-cookie"]).toEqual(["a=1", "b=2"]);
  });
});

describe("errors", () => {
  test("コードから HTTP ステータスと開発者向けの英語の文言を決める", () => {
    const error = new AppError("DUPLICATE_LINK", { details: { existing: { name: "x" } } });
    expect(error.status).toBe(409);
    expect(errorBody(error)).toEqual({
      error: {
        code: "DUPLICATE_LINK",
        message: "A document with the same link already exists in this project.",
        details: { existing: { name: "x" } },
      },
    });
    expect(errorBody(new AppError("NOT_FOUND")).error).not.toHaveProperty("details");
  });

  test("形式が違う UUID は指定したコードの NotFound にする", () => {
    expect(parseUuid("0B6F1C2D-0000-4000-8000-000000000000", "NOT_FOUND")).toBe(
      "0b6f1c2d-0000-4000-8000-000000000000",
    );
    expect(() => parseUuid("x", "PROJECT_NOT_FOUND")).toThrow(AppError);
  });

  test("Drizzle が包んだ DB エラーの SQLSTATE を cause から読む", () => {
    const pg = Object.assign(new Error("dup"), {
      code: "23505",
      constraint_name: "users_email_key",
    });
    const wrapped = new Error("Failed query", { cause: pg });
    expect(isUniqueViolation(wrapped)).toBe(true);
    expect(isUniqueViolation(wrapped, "users_email_key")).toBe(true);
    expect(isUniqueViolation(wrapped, "other")).toBe(false);
    expect(isUniqueViolation(new Error("x"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });

  test("接続できないエラーだけを DB の一時的な障害として扱う", () => {
    expect(isDbUnavailable(Object.assign(new Error(), { code: "ECONNREFUSED" }))).toBe(true);
    expect(isDbUnavailable(Object.assign(new Error(), { code: "CONNECT_TIMEOUT" }))).toBe(true);
    expect(isDbUnavailable(Object.assign(new Error(), { code: "08006" }))).toBe(true);
    expect(isDbUnavailable(new Error("x", { cause: { code: "57P01" } }))).toBe(true);
    expect(isDbUnavailable(Object.assign(new Error(), { code: "23505" }))).toBe(false);
    expect(isDbUnavailable(new Error("x"))).toBe(false);
  });
});

describe("assertSameOrigin", () => {
  const post = (headers: Record<string, string>, body?: string) =>
    new Request("http://localhost/api/x", { method: "POST", headers, body });

  test("GET は確認しない。状態を変えるメソッドは Origin が一致し、本文は JSON だけ", () => {
    const origin = "http://localhost:5173";
    expect(() => assertSameOrigin(new Request("http://localhost/api/x"), origin)).not.toThrow();
    expect(() => assertSameOrigin(post({ origin }), origin)).not.toThrow();
    expect(() =>
      assertSameOrigin(
        post({ origin, "content-type": "application/json; charset=utf-8" }, "{}"),
        origin,
      ),
    ).not.toThrow();
    expect(() => assertSameOrigin(post({}), origin)).toThrow(AppError);
    expect(() => assertSameOrigin(post({ origin: "http://localhost:5174" }), origin)).toThrow(
      AppError,
    );
    expect(() =>
      assertSameOrigin(post({ origin, "content-type": "text/plain" }, "x"), origin),
    ).toThrow(AppError);
  });
});

describe("requestState", () => {
  test("トレース ID が不正なら乱数にする。同じリクエストには同じ ID", () => {
    const request = new Request("http://localhost/api/x", {
      headers: { "x-cloud-trace-context": "not-a-trace/1" },
    });
    const state = requestState(request);
    expect(state.id).toMatch(/^[0-9a-f]{32}$/);
    expect(requestState(request)).toBe(state);
  });
});

describe("logger", () => {
  test("レベルより低いログは出さず、trace はプロジェクト ID があるときだけ付ける", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "warn", gcpProjectId: "p", write: (l) => lines.push(l) });
    logger.info("skipped");
    logger.warn("kept", { event: "e", requestId: "abc", code: "X" });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toEqual({
      severity: "WARN",
      message: "kept",
      event: "e",
      requestId: "abc",
      code: "X",
      "logging.googleapis.com/trace": "projects/p/traces/abc",
    });
  });
});
