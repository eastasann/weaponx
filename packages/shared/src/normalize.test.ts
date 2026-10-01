import { describe, expect, test } from "bun:test";
import { labelKey, nameKey, normalizeKey } from "./normalize";

describe("normalizeKey", () => {
  test("全角の英数字と大文字を半角・小文字にそろえる", () => {
    expect(normalizeKey("ＡＢＣ１２３")).toBe("abc123");
    expect(normalizeKey("Final")).toBe(normalizeKey("final"));
  });

  test("半角カナは全角カナにそろう", () => {
    expect(normalizeKey("ﾃﾝﾌﾟﾚｰﾄ")).toBe("テンプレート");
  });

  test("前後の空白を取り除く", () => {
    expect(normalizeKey("  提出 ")).toBe("提出");
  });

  test("名前とタグは同じ規則", () => {
    expect(nameKey("Ｖ２")).toBe("v2");
    expect(labelKey("Ｖ２")).toBe("v2");
  });
});
