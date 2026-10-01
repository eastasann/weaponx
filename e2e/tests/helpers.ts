import { expect, type Page } from "@playwright/test";

/** 開発用ログイン(02-01 5.10)で、名前の利用者として入る */
export async function devLogin(page: Page, name: string, from = "/login") {
  await page.goto(from);
  await page.getByRole("button", { name: new RegExp(name) }).click();
}

export async function expectHeaderUser(page: Page, name: string) {
  await expect(page.getByRole("button", { name: new RegExp(name) })).toBeVisible();
}

// 案件を作って資料を足すテスト共通の操作。作ったものが他のテストのデータ(シードの件数・並び)を変えないよう、各テストは自分の案件の中で操作する
export async function createProject(page: Page, name: string) {
  await page.getByRole("button", { name: "+ 案件を作る" }).click();
  await page.getByRole("textbox", { name: "案件名" }).fill(name);
  await page.getByRole("button", { name: "作成" }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
}

export async function startInNewProject(page: Page, name: string, user = "山田 太郎") {
  await devLogin(page, user);
  await expectHeaderUser(page, user);
  await createProject(page, name);
}

export const addButton = (page: Page) => page.getByRole("button", { name: "+ 資料を追加" }).first();
export const addDialog = (page: Page) => page.getByRole("dialog", { name: "資料を追加" });
export const panel = (page: Page) => page.getByRole("region", { name: "資料の詳細" });

/** 「新しく作る」でドキュメントを1つ作る。編集画面の別タブはここでは見ない */
export async function createDocument(page: Page, name: string, kind = "google_doc") {
  await addButton(page).click();
  const dialog = addDialog(page);
  await dialog.getByRole("combobox", { name: "種別" }).selectOption(kind);
  await dialog.getByRole("textbox", { name: "資料名" }).fill(name);
  await dialog.getByRole("button", { name: "作成" }).click();
  await expect(panel(page).getByRole("heading", { name })).toBeVisible();
}

/** 「リンクで登録」で資料を1つ登録する(アプリがまだ使えないファイルの手入力の名前で登録できる) */
export async function registerByLink(page: Page, url: string, name: string) {
  await addButton(page).click();
  const dialog = addDialog(page);
  await dialog.getByRole("tab", { name: "リンクで登録" }).click();
  await dialog.getByRole("textbox", { name: "リンク" }).fill(url);
  await dialog.getByRole("textbox", { name: "資料名" }).fill(name);
  await dialog.getByRole("button", { name: "追加" }).click();
  await expect(panel(page).getByRole("heading", { name })).toBeVisible();
}
