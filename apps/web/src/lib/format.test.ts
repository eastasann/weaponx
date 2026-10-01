import { describe, expect, test } from "bun:test";
import { formatDate, formatDateTime, nameCollator } from "./format";

// 2026-09-28 05:05 UTC は日本時間で 14:05
const ISO = "2026-09-28T05:05:00Z";

describe("日時の書式(design-spec 1.2)", () => {
  test("日本語は 2026/09/28 と 2026/09/28 14:05", () => {
    expect(formatDate(ISO, "ja", "Asia/Tokyo")).toBe("2026/09/28");
    expect(formatDateTime(ISO, "ja", "Asia/Tokyo")).toBe("2026/09/28 14:05");
  });

  test("英語は Sep 28, 2026 と Sep 28, 2026, 2:05 PM", () => {
    expect(formatDate(ISO, "en", "Asia/Tokyo")).toBe("Sep 28, 2026");
    expect(formatDateTime(ISO, "en", "Asia/Tokyo")).toBe("Sep 28, 2026, 2:05 PM");
  });

  test("月・日・時分を2桁にそろえる", () => {
    expect(formatDateTime("2026-01-02T00:03:00Z", "ja", "UTC")).toBe("2026/01/02 00:03");
  });

  test("タイムゾーンはブラウザのものに従う(指定した場所の日付になる)", () => {
    expect(formatDate("2026-09-28T20:00:00Z", "ja", "Asia/Tokyo")).toBe("2026/09/29");
    expect(formatDate("2026-09-28T20:00:00Z", "ja", "UTC")).toBe("2026/09/28");
  });
});

describe("名前の並べ替え", () => {
  test("表示言語の辞書順に並べる", () => {
    const sorted = ["う", "あ", "い"].sort(nameCollator("ja").compare);
    expect(sorted).toEqual(["あ", "い", "う"]);
    expect(["b", "A", "a"].sort(nameCollator("en").compare)).toEqual(["a", "A", "b"]);
  });
});
