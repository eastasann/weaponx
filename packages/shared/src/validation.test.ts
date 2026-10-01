import { describe, expect, test } from "bun:test";
import { countGraphemes, validateEmail, validateSingleLine } from "./validation";

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
