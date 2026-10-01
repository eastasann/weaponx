import type { Locale } from "./locale";

const INTL_LOCALE: Record<Locale, string> = { ja: "ja-JP", en: "en-US" };

// 新しい ICU は英語の時刻の AM/PM の前に狭いノーブレークスペースを入れる。書式の見本(design-spec 1.2)に合わせて通常の空白にする
const normalizeSpaces = (value: string) => value.replace(/[  ]/g, " ");

/** 日付。日本語は 2026/09/28、英語は Sep 28, 2026(design-spec 1.2) */
export function formatDate(iso: string, locale: Locale, timeZone?: string): string {
  const date = new Date(iso);
  const formatted =
    locale === "ja"
      ? new Intl.DateTimeFormat(INTL_LOCALE.ja, {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          timeZone,
        }).format(date)
      : new Intl.DateTimeFormat(INTL_LOCALE.en, {
          year: "numeric",
          month: "short",
          day: "numeric",
          timeZone,
        }).format(date);
  return normalizeSpaces(formatted);
}

/** 日時。日本語は 2026/09/28 14:05、英語は Sep 28, 2026, 2:05 PM(design-spec 1.2) */
export function formatDateTime(iso: string, locale: Locale, timeZone?: string): string {
  const date = new Date(iso);
  const formatted =
    locale === "ja"
      ? new Intl.DateTimeFormat(INTL_LOCALE.ja, {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
          timeZone,
        }).format(date)
      : new Intl.DateTimeFormat(INTL_LOCALE.en, {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          timeZone,
        }).format(date);
  return normalizeSpaces(formatted);
}

/** 名前の並べ替えは表示言語の辞書順(design-spec 1.2) */
export function nameCollator(locale: Locale): Intl.Collator {
  return new Intl.Collator(INTL_LOCALE[locale]);
}
