import { expect, test } from "@playwright/test";
import { devLogin, expectHeaderUser } from "./helpers";

test.describe("ログインとヘッダー", () => {
  test("開発用ログインで入るとホームが開き、ヘッダーに利用者が出る", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("button", { name: /Google でログイン/ })).toBeVisible();
    await page.getByRole("button", { name: /山田 太郎/ }).click();
    await expect(page).toHaveURL("/");
    await expect(page.getByRole("link", { name: "weaponx" })).toBeVisible();
    await expectHeaderUser(page, "山田 太郎");
    // 更新系の操作が CSRF の確認で弾かれない(Referrer-Policy: strict-origin)
    await page.getByRole("button", { name: /山田 太郎/ }).click();
    await expect(page.getByRole("menuitem", { name: "利用者管理" })).toBeVisible();
    await page.getByRole("menuitem", { name: "ログアウト" }).click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test("ログアウトするとログイン画面に戻り、保護された画面は開けない", async ({ page }) => {
    await devLogin(page, "佐藤 花子");
    await expectHeaderUser(page, "佐藤 花子");
    await page.getByRole("button", { name: /佐藤 花子/ }).click();
    // 管理者でない人には利用者管理を出さない
    await expect(page.getByRole("menuitem", { name: "利用者管理" })).toHaveCount(0);
    const loggedOut = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/auth/logout") && response.request().method() === "POST",
    );
    await page.getByRole("menuitem", { name: "ログアウト" }).click();
    expect((await loggedOut).status()).toBe(204);
    await expect(page).toHaveURL(/\/login$/);
    await page.goto("/");
    await expect(page).toHaveURL(/\/login\?returnTo=%2F$|\/login$/);
  });

  test("未ログインで案件の URL を開くと、ログインの後に元の URL へ戻る", async ({ page }) => {
    const target = "/projects/00000000-0000-0000-0000-000000000001?series=abc";
    await page.goto(target);
    await expect(page).toHaveURL(`/login?returnTo=${encodeURIComponent(target)}`);
    await page.getByRole("button", { name: /山田 太郎/ }).click();
    await expect(page).toHaveURL(target);
    await expectHeaderUser(page, "山田 太郎");
  });

  test("停止中の鈴木はログイン画面に停止の表示が出る", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: /鈴木 一郎/ }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("alert")).toHaveText(
      "このアカウントは停止されています。管理者に連絡してください。",
    );
  });

  test("ログイン済みでログイン画面を開くとホームへ移る", async ({ page }) => {
    await devLogin(page, "山田 太郎");
    await expectHeaderUser(page, "山田 太郎");
    await page.goto("/login");
    await expect(page).toHaveURL("/");
  });
});

test.describe("エラー画面", () => {
  test("存在しない URL はページが見つかりません。ログイン中はホームへ戻れる", async ({ page }) => {
    await devLogin(page, "山田 太郎");
    await expectHeaderUser(page, "山田 太郎");
    await page.goto("/no/such/page");
    await expect(page.getByRole("heading", { name: "ページが見つかりません" })).toBeVisible();
    await page.getByRole("link", { name: "ホームへ" }).click();
    await expect(page).toHaveURL("/");
  });

  test("未ログインでは戻り先がログイン", async ({ page }) => {
    await page.goto("/no/such/page");
    await expect(page.getByRole("heading", { name: "ページが見つかりません" })).toBeVisible();
    await page.getByRole("link", { name: "ログインへ" }).click();
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe("表示言語", () => {
  test("ログイン画面で切り替えた言語をブラウザが覚える", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "English" }).click();
    await expect(page.getByRole("button", { name: /Log in with Google/ })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: /Log in with Google/ })).toBeVisible();
    await page.getByRole("button", { name: "日本語" }).click();
    await expect(page.getByRole("button", { name: /Google でログイン/ })).toBeVisible();
  });

  test("ログイン後はユーザーメニューで切り替えると、利用者の設定にも保存される", async ({
    page,
  }) => {
    await devLogin(page, "佐藤 花子");
    await expectHeaderUser(page, "佐藤 花子");
    await page.getByRole("button", { name: /佐藤 花子/ }).click();
    const saved = page.waitForResponse(
      (response) => response.url().endsWith("/api/me") && response.request().method() === "PATCH",
    );
    await page.getByRole("menuitemradio", { name: "English" }).click();
    expect((await saved).status()).toBe(200);
    await page.getByRole("button", { name: /佐藤 花子/ }).click();
    await expect(page.getByRole("menuitem", { name: "Log out" })).toBeVisible();
    // 利用者の設定が英語になったので、次にログインしても英語
    await page.getByRole("menuitem", { name: "Log out" }).click();
    await page.evaluate(() => localStorage.clear());
    await page.goto("/login");
    await page.getByRole("button", { name: /佐藤 花子/ }).click();
    await page.getByRole("button", { name: /佐藤 花子/ }).click();
    await expect(page.getByRole("menuitem", { name: "Log out" })).toBeVisible();
    // 後のテストに影響しないよう日本語に戻す
    await page.getByRole("menuitemradio", { name: "日本語" }).click();
  });
});

test.describe("ドライブの再連携", () => {
  test("田中で入ると要再連携の帯が出て、もう一度連携すると帯が消えて通知が出る", async ({
    page,
  }) => {
    await devLogin(page, "田中 美咲");
    const banner = page.getByRole("alert");
    await expect(banner).toContainText("ドライブ連携の有効期限が切れました");
    await banner.getByRole("button", { name: "もう一度連携する" }).click();
    await expect(page.getByText("ドライブに再連携しました").first()).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    // 連携中に戻っているので、開き直しても帯は出ない
    await page.reload();
    await expectHeaderUser(page, "田中 美咲");
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
});
