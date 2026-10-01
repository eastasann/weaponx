import { describe, expect, test } from "bun:test";
import {
  countGraphemes,
  validateEmail,
  validateSingleLine,
  validateSourceModifiedAt,
  validateUrl,
} from "./validation";

describe("countGraphemes", () => {
  test("見た目の1文字を1と数える", () => {
    expect(countGraphemes("提案書")).toBe(3);
    expect(countGraphemes("👨‍👩‍👧")).toBe(1);
    expect(countGraphemes("é")).toBe(1);
    expect(countGraphemes("🇯🇵")).toBe(1);
  });
});

describe("validateSingleLine", () => {
  test("前後の空白を取り除く", () => {
    expect(validateSingleLine("  A社 DX提案 ", { max: 100 })).toEqual({
      ok: true,
      value: "A社 DX提案",
    });
  });

  test("空白だけは空として扱う", () => {
    expect(validateSingleLine(" 　 ", { max: 100 })).toEqual({ ok: false, error: "required" });
    expect(validateSingleLine("   ", { max: 100, required: false })).toEqual({
      ok: true,
      value: "",
    });
  });

  test("改行を含むと invalid_format", () => {
    expect(validateSingleLine("a\nb", { max: 100 })).toEqual({
      ok: false,
      error: "invalid_format",
    });
    expect(validateSingleLine("a\r\nb", { max: 100 })).toEqual({
      ok: false,
      error: "invalid_format",
    });
  });

  test("上限ちょうどは通り、超えると too_long", () => {
    expect(validateSingleLine("あ".repeat(100), { max: 100 }).ok).toBe(true);
    expect(validateSingleLine("あ".repeat(101), { max: 100 })).toEqual({
      ok: false,
      error: "too_long",
    });
  });

  test("結合文字や絵文字の並びは書記素で数える", () => {
    expect(validateSingleLine("👨‍👩‍👧".repeat(100), { max: 100 }).ok).toBe(true);
    expect(validateSingleLine("👨‍👩‍👧".repeat(101), { max: 100 }).ok).toBe(false);
  });
});

describe("validateEmail", () => {
  test("前後の空白を除いて小文字にする", () => {
    expect(validateEmail("  Tanaka@Example.COM ")).toEqual({
      ok: true,
      value: "tanaka@example.com",
    });
  });

  test("空と形式の誤りを区別する", () => {
    expect(validateEmail("  ")).toEqual({ ok: false, error: "required" });
    for (const bad of ["tanaka", "a@b", "a b@c.d", "@x.com", "a@@x.com", "a@x..com"]) {
      expect(validateEmail(bad)).toEqual({ ok: false, error: "invalid_format" });
    }
  });

  test("長すぎるメールは too_long", () => {
    expect(validateEmail(`${"a".repeat(250)}@x.com`)).toEqual({ ok: false, error: "too_long" });
  });
});

describe("validateUrl", () => {
  test("http・https だけを受け付け、前後の空白を取り除く", () => {
    expect(validateUrl("  https://example.com/a  ")).toEqual({
      ok: true,
      value: "https://example.com/a",
    });
    expect(validateUrl("http://example.com")).toEqual({ ok: true, value: "http://example.com" });
  });

  test("空は required、http・https 以外と URL でない文字列は invalid_url", () => {
    expect(validateUrl("   ")).toEqual({ ok: false, error: "required" });
    for (const raw of [
      "javascript:alert(1)",
      "ftp://example.com",
      "example.com",
      "data:text/html,x",
    ]) {
      expect(validateUrl(raw)).toEqual({ ok: false, error: "invalid_url" });
    }
  });

  test("2048文字までは受け付け、超えると too_long", () => {
    const prefix = "https://example.com/";
    expect(validateUrl(prefix + "a".repeat(2048 - prefix.length)).ok).toBe(true);
    expect(validateUrl(prefix + "a".repeat(2049 - prefix.length))).toEqual({
      ok: false,
      error: "too_long",
    });
  });
});

describe("validateSourceModifiedAt", () => {
  const now = new Date("2026-09-30T00:00:00Z");

  test("過去の ISO 8601 の日時を受け付ける", () => {
    expect(validateSourceModifiedAt("2026-09-19T15:00:00Z", now)).toEqual({
      ok: true,
      value: new Date("2026-09-19T15:00:00Z"),
    });
    expect(validateSourceModifiedAt("2026-09-20T00:00:00+09:00", now).ok).toBe(true);
  });

  test("未来は future_date、日時の形式でなければ invalid_format", () => {
    expect(validateSourceModifiedAt("2026-09-30T00:00:01Z", now)).toEqual({
      ok: false,
      error: "future_date",
    });
    for (const raw of ["2026-09-19", "yesterday", "2026-13-40T00:00:00Z", ""]) {
      expect(validateSourceModifiedAt(raw, now)).toEqual({ ok: false, error: "invalid_format" });
    }
  });
});
