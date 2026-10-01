import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../locales/en.json";
import ja from "../locales/ja.json";
import { detectLocale, type Locale, storeLocale } from "./locale";

const initial = detectLocale();

i18n.use(initReactI18next).init({
  resources: { ja: { translation: ja }, en: { translation: en } },
  lng: initial,
  fallbackLng: "ja",
  interpolation: { escapeValue: false },
});
document.documentElement.lang = initial;

/** 表示言語を切り替え、ブラウザに保存する。利用者の設定への保存は呼び出し側(PATCH /api/me)が行う */
export async function setLocale(locale: Locale): Promise<void> {
  storeLocale(locale);
  document.documentElement.lang = locale;
  await i18n.changeLanguage(locale);
}

export default i18n;
