import "i18next";
import type ja from "../locales/ja.json";

// t() のキーを日本語の翻訳ファイルから型にする(ADR-014)。日英のキーの一致は locales.test.ts が確かめる
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: { translation: typeof ja };
  }
}
