import { normalizeKey } from "@weaponx/shared";
import type { RelatedItem, SeriesRow } from "../../lib/queries";

export type KindFilter = "all" | SeriesRow["latest"]["kind"];

/** 表の行のタグの表示用の文字列。旧版に付いたタグは「提出 v2」のように版番号を添える(design-spec 6.1) */
export function tagLabel(tag: SeriesRow["tags"][number]): string {
  return tag.versionNo === null ? tag.label : `${tag.label} v${tag.versionNo}`;
}

/** 先頭から `limit` 個まで出し、残りは「+n」にまとめる(design-spec 6.1) */
export function splitTags(tags: SeriesRow["tags"], limit: number) {
  return { shown: tags.slice(0, limit), rest: tags.slice(limit) };
}

/**
 * 絞り込み(design-spec 6.1)。資料名は系列内の削除されていない版のどれかに部分一致すればよく、
 * 種別は最新版で判定する。大文字・小文字と全角・半角の英数字は区別しない。
 */
export function filterSeries(rows: SeriesRow[], query: string, kind: KindFilter): SeriesRow[] {
  const key = normalizeKey(query);
  return rows.filter(
    (row) =>
      (kind === "all" || row.latest.kind === kind) &&
      (key === "" || row.searchNames.some((name) => normalizeKey(name).includes(key))),
  );
}

type Visible = Extract<RelatedItem, { visibility: "visible" }>;

const rank = (item: RelatedItem): number =>
  item.visibility === "no_access"
    ? 2
    : item.visibility === "deleted"
      ? 3
      : item.projectName === null
        ? 0
        : 1;

/**
 * 関連資料の並び順(design-spec 6.1): 同じ案件、他の案件、見る権限のない資料、削除された資料の順。
 * 同じ区分の中は表示言語の辞書順。API は区分の順に返すが、区分の中の名前順は画面が持つ。
 */
export function sortRelated(items: RelatedItem[], collator: Intl.Collator): RelatedItem[] {
  const name = (item: RelatedItem) => (item.visibility === "visible" ? (item as Visible).name : "");
  return [...items].sort((a, b) => rank(a) - rank(b) || collator.compare(name(a), name(b)));
}
