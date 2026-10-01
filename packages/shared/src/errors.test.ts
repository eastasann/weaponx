import { describe, expect, test } from "bun:test";
import { ERROR_CODES, errorCategory, errorStatus } from "./errors";

describe("エラーコード", () => {
  test("02-01 8章の HTTP ステータスと分類", () => {
    expect(errorStatus("PROJECT_NOT_FOUND")).toBe(404);
    expect(errorStatus("LAST_OWNER")).toBe(409);
    expect(errorStatus("VALIDATION_FAILED")).toBe(422);
    expect(errorStatus("DRIVE_CREATE_FAILED")).toBe(502);
    expect(errorCategory("ROLE_INSUFFICIENT")).toBe("forbidden");
    expect(errorCategory("ACCOUNT_SUSPENDED")).toBe("forbidden");
    expect(errorCategory("MEMBER_NOT_FOUND")).toBe("not_found");
    expect(errorCategory("EMAIL_TAKEN")).toBe("input");
    expect(errorCategory("DRIVE_REAUTH_REQUIRED")).toBe("reauth");
    expect(errorCategory("DRIVE_FILE_NOT_ACCESSIBLE")).toBe("not_a_failure");
    expect(errorCategory("UNAUTHENTICATED")).toBe("session");
    expect(errorCategory("INTERNAL")).toBe("other");
  });

  test("すべてのコードに分類とステータスがある", () => {
    for (const code of ERROR_CODES) {
      expect(errorCategory(code)).toBeTruthy();
      expect(errorStatus(code)).toBeGreaterThanOrEqual(400);
    }
  });
});
