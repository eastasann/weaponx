import { describe, expect, test } from "bun:test";
import { detectKind, isDriveFileId, isHttpUrl, linkKey, parseDriveLink } from "./link";

describe("parseDriveLink", () => {
  test("docs.google.com の3種類からファイル ID と種別を取り出す", () => {
    expect(parseDriveLink("https://docs.google.com/document/d/abc_123-X/edit")).toEqual({
      googleFileId: "abc_123-X",
      kind: "google_doc",
    });
    expect(parseDriveLink("https://docs.google.com/presentation/d/p1/edit#slide=id.g1")).toEqual({
      googleFileId: "p1",
      kind: "google_slides",
    });
    expect(parseDriveLink("https://docs.google.com/spreadsheets/d/s1")).toEqual({
      googleFileId: "s1",
      kind: "google_sheets",
    });
  });

  test("drive.google.com/file/d/{id} は種別を持たない", () => {
    expect(parseDriveLink("https://drive.google.com/file/d/f1/view?usp=sharing")).toEqual({
      googleFileId: "f1",
      kind: null,
    });
  });

  test("前後の空白とクエリがあっても取り出せる", () => {
    expect(parseDriveLink("  https://docs.google.com/document/d/a1?tab=t.0  ")?.googleFileId).toBe(
      "a1",
    );
  });

  test("複数アカウントの /u/{n}/ 付きは同じファイル ID", () => {
    expect(parseDriveLink("https://docs.google.com/document/u/0/d/a1/edit")?.googleFileId).toBe(
      "a1",
    );
    expect(linkKey("https://docs.google.com/document/u/1/d/a1/edit")).toBe(
      linkKey("https://docs.google.com/document/d/a1/edit"),
    );
  });

  test("ウェブに公開のリンク(/d/e/…)と末尾ドットのホスト", () => {
    expect(parseDriveLink("https://docs.google.com/document/d/e/2PACX-1vA/pub")).toBeNull();
    expect(parseDriveLink("https://docs.google.com./document/d/a1/edit")?.googleFileId).toBe("a1");
  });

  test("ホスト名が似ているだけのものは対象にしない", () => {
    expect(parseDriveLink("https://docs.google.com.evil.example/document/d/a1")).toBeNull();
    expect(parseDriveLink("https://docs.google.com@evil.example/document/d/a1")).toBeNull();
  });

  test("ドライブの資料でないものは null", () => {
    expect(parseDriveLink("https://example.com/document/d/a1")).toBeNull();
    expect(parseDriveLink("https://docs.google.com/forms/d/a1")).toBeNull();
    expect(parseDriveLink("https://docs.google.com/document/")).toBeNull();
    expect(parseDriveLink("https://drive.google.com/drive/folders/a1")).toBeNull();
    expect(parseDriveLink("ftp://docs.google.com/document/d/a1")).toBeNull();
    expect(parseDriveLink("not a url")).toBeNull();
  });
});

describe("detectKind", () => {
  test("Google の資料はパスで決める", () => {
    expect(detectKind("https://docs.google.com/document/d/a")).toBe("google_doc");
    expect(detectKind("https://docs.google.com/presentation/d/a")).toBe("google_slides");
    expect(detectKind("https://docs.google.com/spreadsheets/d/a")).toBe("google_sheets");
  });

  test(".pdf で終わるリンクは PDF(大文字も)", () => {
    expect(detectKind("https://example.com/a/report.pdf")).toBe("pdf");
    expect(detectKind("https://example.com/a/REPORT.PDF")).toBe("pdf");
    expect(detectKind("https://example.com/a/report.pdf?dl=1")).toBe("pdf");
  });

  test("それ以外と drive.google.com/file は other", () => {
    expect(detectKind("https://example.com/a")).toBe("other");
    expect(detectKind("https://drive.google.com/file/d/f1/view")).toBe("other");
  });
});

describe("linkKey", () => {
  test("ドライブの資料は URL の違いによらずファイル ID で比べる", () => {
    expect(linkKey("https://docs.google.com/document/d/a1/edit")).toBe("g:a1");
    expect(linkKey("https://docs.google.com/document/d/a1/view?usp=sharing")).toBe("g:a1");
    expect(linkKey("https://drive.google.com/file/d/a1/view")).toBe("g:a1");
  });

  test("それ以外は前後の空白を除いた URL の文字列で比べる", () => {
    expect(linkKey("  https://example.com/x  ")).toBe("u:https://example.com/x");
    expect(linkKey("https://example.com/x")).not.toBe(linkKey("https://example.com/x/"));
  });
});

describe("isHttpUrl", () => {
  test("http と https だけ受け付ける", () => {
    expect(isHttpUrl("https://example.com")).toBe(true);
    expect(isHttpUrl("http://example.com")).toBe(true);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("example.com")).toBe(false);
  });
});

describe("isDriveFileId", () => {
  test("ファイル ID の文字種(英数字・_・-)だけを受け付ける", () => {
    expect(isDriveFileId("1AbC_def-9")).toBe(true);
    for (const value of ["", "a/b", "a b", "a.b", "あ", "a".repeat(257)]) {
      expect(isDriveFileId(value)).toBe(false);
    }
  });
});
