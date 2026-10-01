export type Locale = "ja" | "en";

const STORAGE_KEY = "weaponx.locale";

export function isLocale(value: unknown): value is Locale {
  return value === "ja" || value === "en";
}

/** 保存した選択があればそれを、無ければブラウザの言語設定を使う(design-spec 1.2) */
export function detectLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    // localStorage が使えない環境ではブラウザの言語設定に従う
  }
  return navigator.language.toLowerCase().startsWith("ja") ? "ja" : "en";
}

export function storeLocale(locale: Locale): void {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // 保存できなくても、この画面の表示言語は切り替わる
  }
}
