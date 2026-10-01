/**
 * 検索と絞り込みに使う正規化(NFKC + 小文字)。資料名の `name_key` とタグの `label_key` の値。
 * 「大文字・小文字、全角・半角の英数字は区別しない」(design-spec 6.1・6.4・6.0.3)。
 * 保存する前に前後の空白を取り除くので、ここでも取り除いてから比べる。
 */
export function normalizeKey(value: string): string {
  return value.trim().normalize("NFKC").toLowerCase();
}

export const nameKey = normalizeKey;
export const labelKey = normalizeKey;
