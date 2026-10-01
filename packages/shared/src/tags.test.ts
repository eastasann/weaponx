import { describe, expect, test } from "bun:test";
import { validateTags } from "./tags";

describe("validateTags", () => {
  test("前後の空白を取り除き、入力した順に返す", () => {
    expect(validateTags([" 提出 ", "確定"])).toEqual({
      ok: true,
      value: [
        { label: "提出", key: "提出" },
        { label: "確定", key: "確定" },
      ],
    });
  });

  test("大文字・小文字、全角・半角の英数字だけが違うタグは重複で、先に入力したものを残す", () => {
    expect(validateTags(["Final", "final", "ＦＩＮＡＬ"])).toEqual({
      ok: true,
      value: [{ label: "Final", key: "final" }],
    });
  });

  test("重複を除いて5件までは受け付け、6件目で too_many", () => {
    expect(validateTags(["a", "b", "c", "d", "e", "A"]).ok).toBe(true);
    expect(validateTags(["a", "b", "c", "d", "e", "f"])).toEqual({ ok: false, error: "too_many" });
  });

  test("空のタグは required、20文字を超えると too_long、改行は invalid_format", () => {
    expect(validateTags(["  "])).toEqual({ ok: false, error: "required" });
    expect(validateTags(["あ".repeat(21)])).toEqual({ ok: false, error: "too_long" });
    expect(validateTags(["あ".repeat(20)]).ok).toBe(true);
    expect(validateTags(["a\nb"])).toEqual({ ok: false, error: "invalid_format" });
  });
});
