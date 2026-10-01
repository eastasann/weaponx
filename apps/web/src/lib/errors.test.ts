import { describe, expect, test } from "bun:test";
import { ERROR_CODES } from "@weaponx/shared";
import en from "../locales/en.json";
import ja from "../locales/ja.json";
import { ApiError, describeError, fieldErrors, parseApiError, toApiError } from "./errors";

describe("parseApiError", () => {
  test("エラーの本文の code と details を読む", () => {
    const error = parseApiError(
      409,
      { error: { code: "DUPLICATE_LINK", details: { existing: { name: "提案書" } } } },
      "req-1",
    );
    expect(error.code).toBe("DUPLICATE_LINK");
    expect(error.status).toBe(409);
    expect(error.requestId).toBe("req-1");
    expect(error.details).toEqual({ existing: { name: "提案書" } });
  });

  test("JSON でない 429 は RATE_LIMITED(Cloud Armor。02-01 8章)", () => {
    expect(parseApiError(429, "Too Many Requests").code).toBe("RATE_LIMITED");
  });

  test("未知の code・形の違う本文は INTERNAL、404 は NOT_FOUND", () => {
    expect(parseApiError(500, { error: { code: "SOMETHING_NEW" } }).code).toBe("INTERNAL");
    expect(parseApiError(502, null).code).toBe("INTERNAL");
    expect(parseApiError(404, "<html>").code).toBe("NOT_FOUND");
  });
});

describe("toApiError", () => {
  test("ネットワークの切断などの例外は INTERNAL と同じ分類(02-01 8章)", () => {
    const error = toApiError(new TypeError("Failed to fetch"));
    expect(error.code).toBe("INTERNAL");
    expect(error.status).toBe(0);
  });

  test("ApiError はそのまま返す", () => {
    const original = new ApiError("LAST_OWNER", { status: 409 });
    expect(toApiError(original)).toBe(original);
  });
});

describe("describeError(design-spec 6.0.2 の5分類)", () => {
  test.each([
    ["PROJECT_NOT_FOUND", "not_found"],
    ["DOCUMENT_NOT_FOUND", "not_found"],
    ["MEMBER_NOT_FOUND", "not_found"],
    ["ROLE_INSUFFICIENT", "forbidden"],
    ["ADMIN_REQUIRED", "forbidden"],
    ["ACCOUNT_SUSPENDED", "forbidden"],
    ["VALIDATION_FAILED", "input"],
    ["DUPLICATE_LINK", "input"],
    ["LAST_ADMIN", "input"],
    ["DRIVE_REAUTH_REQUIRED", "reauth"],
    ["INTERNAL", "other"],
    ["SERVICE_UNAVAILABLE", "other"],
    ["RATE_LIMITED", "other"],
  ] as const)("%s は %s", (code, category) => {
    const display = describeError(new ApiError(code, { status: 400 }));
    expect(display.category).toBe(category);
    expect(display.messageKey).toBe(`errors.${code}`);
  });

  test("読み込みの失敗(通信・その他)は「読み込めませんでした」にする", () => {
    expect(describeError(new TypeError("offline"), "read").messageKey).toBe("errors.loadFailed");
    expect(describeError(new TypeError("offline"), "write").messageKey).toBe("errors.INTERNAL");
    // 通信・その他以外は読み込みでも変わらない
    expect(
      describeError(new ApiError("PROJECT_NOT_FOUND", { status: 404 }), "read").messageKey,
    ).toBe("errors.PROJECT_NOT_FOUND");
  });

  test("全てのエラーコードに日英の文言がある", () => {
    for (const code of ERROR_CODES) {
      expect(ja.errors).toHaveProperty(code);
      expect(en.errors).toHaveProperty(code);
    }
  });
});

describe("fieldErrors", () => {
  test("VALIDATION_FAILED の欄ごとの理由を返す", () => {
    const error = new ApiError("VALIDATION_FAILED", {
      status: 422,
      details: { fields: { name: "too_long", url: "invalid_url" } },
    });
    expect(fieldErrors(error)).toEqual({ name: "too_long", url: "invalid_url" });
  });

  test("VALIDATION_FAILED 以外は空", () => {
    expect(fieldErrors(new ApiError("INTERNAL", { status: 500 }))).toEqual({});
  });
});
