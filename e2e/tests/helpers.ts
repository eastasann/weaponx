import { expect, type Page } from "@playwright/test";

/** 開発用ログイン(02-01 5.10)で、名前の利用者として入る */
export async function devLogin(page: Page, name: string, from = "/login") {
  await page.goto(from);
  await page.getByRole("button", { name: new RegExp(name) }).click();
}

export async function expectHeaderUser(page: Page, name: string) {
  await expect(page.getByRole("button", { name: new RegExp(name) })).toBeVisible();
}
