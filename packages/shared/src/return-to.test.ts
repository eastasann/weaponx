import { describe, expect, test } from "bun:test";
import { isSafeReturnTo, safeReturnTo } from "./return-to";

describe("isSafeReturnTo", () => {
  test("/ で始まる相対パス(検索パラメーターとハッシュを含む)を受け付ける", () => {
    for (const ok of ["/", "/projects/abc?series=1&doc=2", "/?q=%E6%A1%88", "/a#b"]) {
      expect(isSafeReturnTo(ok)).toBe(true);
    }
  });

  test("別のオリジンに出られる形を受け付けない", () => {
    const bad = [
      "",
      "projects",
      "//evil.example.com",
      "/\\evil.example.com",
      "https://evil.example.com",
      "javascript:alert(1)",
      "/a\nb",
      "/a\tb",
      "/a\u0000b",
      `/${"a".repeat(2048)}`,
    ];
    for (const value of bad) expect(isSafeReturnTo(value)).toBe(false);
  });
});

describe("safeReturnTo", () => {
  test("受け付けられない値や空はホームにする", () => {
    expect(safeReturnTo("//x")).toBe("/");
    expect(safeReturnTo(undefined)).toBe("/");
    expect(safeReturnTo(null)).toBe("/");
    expect(safeReturnTo("/projects/1")).toBe("/projects/1");
  });
});
