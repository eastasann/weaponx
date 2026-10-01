import { useTranslation } from "react-i18next";
import type { Locale } from "./locale";

/** 今の表示言語。切り替えると再描画される */
export function useLocale(): Locale {
  return useTranslation().i18n.language === "en" ? "en" : "ja";
}
