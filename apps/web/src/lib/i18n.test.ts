import { afterAll, describe, expect, test } from "bun:test";
import i18n, { setLocale } from "./i18n";

afterAll(() => setLocale("ja"));

describe("表示言語の切り替えと複数形(02-01 9章)", () => {
  test("英語は件数で単数と複数を区別する", async () => {
    await setLocale("en");
    expect(i18n.t("common.documentCount", { count: 1 })).toBe("1 document");
    expect(i18n.t("common.documentCount", { count: 2 })).toBe("2 documents");
    expect(i18n.t("common.documentCount", { count: 0 })).toBe("0 documents");
  });

  test("日本語は単数と複数を区別しない", async () => {
    await setLocale("ja");
    expect(i18n.t("common.documentCount", { count: 1 })).toBe("1件");
    expect(i18n.t("common.documentCount", { count: 2 })).toBe("2件");
  });

  test("切り替えをブラウザに保存し、html の lang を変える", async () => {
    await setLocale("en");
    expect(localStorage.getItem("weaponx.locale")).toBe("en");
    expect(document.documentElement.lang).toBe("en");
  });
});
