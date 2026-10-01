import { describe, expect, test } from "bun:test";
import type { RelatedItem, SeriesRow } from "../../lib/queries";
import { filterSeries, sortRelated, splitTags, tagLabel } from "./series-view";

const row = (name: string, kind: SeriesRow["latest"]["kind"], searchNames: string[]) =>
  ({ id: name, latest: { kind, name }, searchNames }) as unknown as SeriesRow;

describe("tagLabel / splitTags", () => {
  test("旧版に付いたタグは版番号を添える", () => {
    expect(tagLabel({ label: "提出", versionNo: 2 })).toBe("提出 v2");
    expect(tagLabel({ label: "確認済", versionNo: null })).toBe("確認済");
  });

  test("先頭から limit 個まで出し、残りは別にまとめる", () => {
    const tags = [
      { label: "a", versionNo: null },
      { label: "b", versionNo: 2 },
      { label: "c", versionNo: 1 },
    ];
    expect(splitTags(tags, 2)).toEqual({ shown: tags.slice(0, 2), rest: tags.slice(2) });
    expect(splitTags(tags, 1).rest).toHaveLength(2);
  });
});

describe("filterSeries", () => {
  const rows = [
    row("提案書 v3", "google_slides", ["提案書 v3", "提案書 v2", "Proposal"]),
    row("見積書", "google_sheets", ["見積書", "見積書 v1"]),
  ];

  test("旧版の名前にも部分一致する", () => {
    expect(filterSeries(rows, "v2", "all").map((r) => r.id)).toEqual(["提案書 v3"]);
  });

  test("大文字・小文字と全角・半角の英数字を区別しない", () => {
    expect(filterSeries(rows, "ｐｒｏｐｏｓａｌ", "all")).toHaveLength(1);
    expect(filterSeries(rows, "PROPOSAL", "all")).toHaveLength(1);
  });

  test("種別は最新版で判定する", () => {
    expect(filterSeries(rows, "", "google_sheets").map((r) => r.id)).toEqual(["見積書"]);
    expect(filterSeries(rows, "提案", "google_sheets")).toHaveLength(0);
  });
});

describe("sortRelated", () => {
  const collator = new Intl.Collator("ja-JP");
  const visible = (name: string, projectName: string | null): RelatedItem =>
    ({ visibility: "visible", name, projectName }) as RelatedItem;

  test("同じ案件、他の案件、見る権限のない資料、削除された資料の順で、区分の中は名前順", () => {
    const sorted = sortRelated(
      [
        { visibility: "deleted" },
        visible("う", "B社"),
        { visibility: "no_access" },
        visible("い", null),
        visible("あ", null),
      ],
      collator,
    );
    expect(
      sorted.map((item) => (item.visibility === "visible" ? item.name : item.visibility)),
    ).toEqual(["あ", "い", "う", "no_access", "deleted"]);
  });
});
