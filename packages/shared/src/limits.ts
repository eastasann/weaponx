/** 入力の上限(design-spec 6.0.3)。文字数は書記素で数える。API と画面で同じ値を使う */
export const LIMITS = {
  projectName: 100,
  documentName: 200,
  url: 2048,
  searchQuery: 100,
  changeNote: 100,
  tag: 20,
  referencesPerVersion: 20,
  tagsPerVersion: 5,
  /** 横断検索の結果の最大件数(design-spec 6.4) */
  searchResults: 50,
  /** 入力欄の候補(参考資料・招待する人・タグ)の表示件数 */
  candidates: 20,
  /** RFC 5321 のメールアドレスの上限 */
  email: 254,
} as const;
