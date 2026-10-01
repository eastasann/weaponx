import { expect, type Page, test } from "@playwright/test";
import { devLogin, expectHeaderUser } from "./helpers";

// 利用者管理 A1(design-spec 6.5.4)。シードの利用者の状態を変えるテストは、最後に元へ戻す

const CONTEXT = { baseURL: "http://web-e2e:5173", locale: "ja-JP", timezoneId: "Asia/Tokyo" };

async function openAdmin(page: Page, user = "山田 太郎") {
  await devLogin(page, user);
  await expectHeaderUser(page, user);
  await page.getByRole("button", { name: /ユーザーメニュー/ }).click();
  await page.getByRole("menuitem", { name: "利用者管理" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "利用者管理" })).toBeVisible();
}

const userRow = (page: Page, text: string) => page.getByRole("row", { name: new RegExp(text) });
const menu = (page: Page, name: string) => page.getByRole("button", { name: `${name}の操作` });

async function addUser(page: Page, email: string, admin = false) {
  await page.getByRole("button", { name: "+ 利用者を追加" }).click();
  const dialog = page.getByRole("dialog", { name: "利用者を追加" });
  await dialog.getByRole("textbox", { name: "メールアドレス" }).fill(email);
  if (admin) await dialog.getByRole("checkbox", { name: "管理者にする" }).check();
  await dialog.getByRole("button", { name: "追加", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

test.describe("表の表示", () => {
  test("有効な利用者が先、停止中が後。未ログインはメールで出て、自分の行の操作は無効", async ({
    page,
  }) => {
    await openAdmin(page);
    const rows = page.getByRole("row");
    await expect(rows).toHaveCount(6);
    const text = await rows.allTextContents();
    const index = (needle: string) => text.findIndex((row) => row.includes(needle));
    // 有効な人が先、その中でログイン済みが先、未ログインはメール順で末尾、停止中は最後
    expect(index("new@example.com")).toBeGreaterThan(index("tanaka@example.com"));
    expect(index("suzuki@example.com")).toBeGreaterThan(index("new@example.com"));
    await expect(userRow(page, "new@example.com")).toContainText("(未ログイン)");
    await expect(userRow(page, "new@example.com")).toContainText("一般");
    await expect(userRow(page, "suzuki@example.com")).toContainText("停止");
    await expect(userRow(page, "yamada@example.com")).toContainText("管理者");
    await expect(userRow(page, "yamada@example.com")).toContainText("(自分)");
    await expect(userRow(page, "yamada@example.com")).toContainText(
      /\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}/,
    );
    await expect(menu(page, "山田 太郎")).toBeDisabled();
    await expect(page.getByText("※ 無効: 自分自身は変更できません")).toBeVisible();
  });

  test("名前・メールで絞り込み、0件ならその旨を出す", async ({ page }) => {
    await openAdmin(page);
    const filter = page.getByRole("searchbox", { name: "名前・メールで絞り込み" });
    await filter.fill("SATO");
    await expect(page.getByRole("row")).toHaveCount(2);
    await expect(userRow(page, "sato@example.com")).toBeVisible();
    await filter.fill("存在しない人");
    await expect(page.getByText("条件に合う利用者がいません")).toBeVisible();
  });

  test("管理者でない人は権限なしの表示になり、ユーザーメニューにも入口が出ない", async ({
    page,
  }) => {
    await devLogin(page, "田中 美咲");
    await page.getByRole("button", { name: /ユーザーメニュー/ }).click();
    await expect(page.getByRole("menuitem", { name: "利用者管理" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.goto("/admin/users");
    await expect(page.getByText("この画面を開く権限がありません")).toBeVisible();
    await page.getByRole("link", { name: "ホームへ" }).click();
    await expect(page).toHaveURL("/");
  });
});

test.describe("利用者を追加・管理者・停止", () => {
  test("追加の入力の不備を欄の下に出し、追加した人は有効で未ログインになる", async ({ page }) => {
    await openAdmin(page);
    await page.getByRole("button", { name: "+ 利用者を追加" }).click();
    const dialog = page.getByRole("dialog", { name: "利用者を追加" });
    const email = dialog.getByRole("textbox", { name: "メールアドレス" });
    const submit = dialog.getByRole("button", { name: "追加", exact: true });
    await expect(submit).toBeDisabled();
    await email.fill("not-an-email");
    await expect(dialog.getByText("メールアドレスの形式が正しくありません")).toBeVisible();
    await expect(submit).toBeDisabled();
    await email.fill("YAMADA@example.com");
    await submit.click();
    await expect(dialog.getByText("このメールアドレスはすでに登録されています")).toBeVisible();
    await expect(dialog).toBeVisible();

    await email.fill("  E2E-New@Example.com ");
    await dialog.getByRole("checkbox", { name: "管理者にする" }).check();
    await submit.click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("利用者を追加しました").first()).toBeVisible();
    const row = userRow(page, "e2e-new@example.com");
    await expect(row).toContainText("(未ログイン)");
    await expect(row).toContainText("管理者");
    await expect(row).toContainText("有効");
  });

  test("管理者にする・外す、停止・再開ができる。停止の確認は警告なしで出る", async ({ page }) => {
    await openAdmin(page);
    await addUser(page, "e2e-flow@example.com");
    const row = userRow(page, "e2e-flow@example.com");
    await expect(row).toContainText("一般");

    await menu(page, "e2e-flow@example.com").click();
    await page.getByRole("menuitem", { name: "管理者にする" }).click();
    await expect(page.getByText("管理者にしました").first()).toBeVisible();
    await expect(row).toContainText("管理者");
    await menu(page, "e2e-flow@example.com").click();
    await page.getByRole("menuitem", { name: "管理者から外す" }).click();
    await expect(page.getByText("管理者から外しました").first()).toBeVisible();
    await expect(row).toContainText("一般");

    await menu(page, "e2e-flow@example.com").click();
    await page.getByRole("menuitem", { name: "停止" }).click();
    const dialog = page.getByRole("dialog", { name: "利用者を停止" });
    await expect(
      dialog.getByText("e2e-flow@example.comを停止します。この人はログインできなくなります。"),
    ).toBeVisible();
    await expect(dialog.getByText("唯一のオーナーになっている案件")).toHaveCount(0);
    await dialog.getByRole("button", { name: "停止", exact: true }).click();
    await expect(page.getByText("利用者を停止しました").first()).toBeVisible();
    await expect(row).toContainText("停止");

    await menu(page, "e2e-flow@example.com").click();
    await page.getByRole("menuitem", { name: "再開" }).click();
    await expect(page.getByText("利用者を再開しました").first()).toBeVisible();
    await expect(row).toContainText("有効");
  });

  test("唯一のオーナーの案件がある人の停止は、件数を警告色で添える(案件名は出さない)", async ({
    page,
  }) => {
    await openAdmin(page);
    await menu(page, "田中 美咲").click();
    await page.getByRole("menuitem", { name: "停止" }).click();
    const dialog = page.getByRole("dialog", { name: "利用者を停止" });
    const warning = dialog.getByText(/この人が唯一のオーナーになっている案件が \d+ 件あります。/);
    await expect(warning).toBeVisible();
    await expect(warning).toContainText(
      "停止すると、その案件ではメンバーの招待・役割の変更・外す、案件名の変更、案件の削除ができなくなります。",
    );
    await expect(dialog).not.toContainText("社内テンプレート集");
    await dialog.getByRole("button", { name: "キャンセル" }).click();
    await expect(userRow(page, "tanaka@example.com")).toContainText("有効");
  });

  test("最後の管理者を外す・停止する操作が失敗したら、通知で理由を出す", async ({ page }) => {
    await openAdmin(page);
    await page.route("**/api/admin/users/*", (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill({ status: 409, json: { error: { code: "LAST_ADMIN", message: "x" } } })
        : route.continue(),
    );
    await menu(page, "佐藤 花子").click();
    await page.getByRole("menuitem", { name: "管理者にする" }).click();
    await expect(page.getByText("管理者が1人以上必要です").first()).toBeVisible();
  });
});

test.describe("別の利用者への影響", () => {
  test("停止された人は、次の操作でログイン画面に戻り、停止の表示が出る", async ({
    page,
    browser,
  }) => {
    const other = await browser.newContext(CONTEXT);
    const sato = await other.newPage();
    await devLogin(sato, "佐藤 花子");
    await expectHeaderUser(sato, "佐藤 花子");

    await openAdmin(page);
    try {
      await menu(page, "佐藤 花子").click();
      await page.getByRole("menuitem", { name: "停止" }).click();
      await page
        .getByRole("dialog", { name: "利用者を停止" })
        .getByRole("button", { name: "停止", exact: true })
        .click();
      await expect(userRow(page, "sato@example.com")).toContainText("停止");

      // 停止してもセッションはその場では消えない。次の操作で止まる
      await sato.getByRole("row", { name: /A社 DX提案/ }).click();
      await expect(sato).toHaveURL(/\/login/);
      await expect(
        sato.getByText("このアカウントは停止されています。管理者に連絡してください。"),
      ).toBeVisible();
    } finally {
      await menu(page, "佐藤 花子").click();
      await page.getByRole("menuitem", { name: "再開" }).click();
      await expect(userRow(page, "sato@example.com")).toContainText("有効");
      await other.close();
    }
  });

  test("管理者を外された人の利用者管理は、次の操作で権限なしの表示に切り替わる", async ({
    page,
    browser,
  }) => {
    await openAdmin(page);
    await menu(page, "佐藤 花子").click();
    await page.getByRole("menuitem", { name: "管理者にする" }).click();
    await expect(userRow(page, "sato@example.com")).toContainText("管理者");

    const other = await browser.newContext(CONTEXT);
    const sato = await other.newPage();
    try {
      await openAdmin(sato, "佐藤 花子");
      await expect(userRow(sato, "yamada@example.com")).toBeVisible();

      await menu(page, "佐藤 花子").click();
      await page.getByRole("menuitem", { name: "管理者から外す" }).click();
      await expect(userRow(page, "sato@example.com")).toContainText("一般");

      await sato.getByRole("button", { name: "+ 利用者を追加" }).click();
      const dialog = sato.getByRole("dialog", { name: "利用者を追加" });
      await dialog.getByRole("textbox", { name: "メールアドレス" }).fill("e2e-late@example.com");
      await dialog.getByRole("button", { name: "追加", exact: true }).click();
      await expect(sato.getByText("この画面を開く権限がありません")).toBeVisible();
      await expect(sato.getByRole("link", { name: "ホームへ" })).toBeVisible();
      await expect(sato.getByRole("table")).toHaveCount(0);
    } finally {
      await other.close();
    }
  });
});

test.describe("モバイル", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("入口を出さず、URL で直接開くとパソコンで開くよう案内する", async ({ page }) => {
    await devLogin(page, "山田 太郎");
    await page.getByRole("button", { name: /ユーザーメニュー/ }).click();
    await expect(page.getByRole("menuitem", { name: "利用者管理" })).toBeHidden();
    await page.keyboard.press("Escape");
    await page.goto("/admin/users");
    await expect(page.getByText("この画面はパソコンで開いてください")).toBeVisible();
    await expect(page.getByRole("table")).toHaveCount(0);
  });
});
