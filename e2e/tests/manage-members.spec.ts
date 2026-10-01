import { expect, type Page, test } from "@playwright/test";
import { createProject, devLogin, expectHeaderUser } from "./helpers";

// メンバー管理 U3(design-spec 6.5.2)。変更するテストは自分で作った案件の中で操作する

const CONTEXT = { baseURL: "http://web-e2e:5173", locale: "ja-JP", timezoneId: "Asia/Tokyo" };

async function openProject(page: Page, projectName: string) {
  await page.getByRole("row", { name: new RegExp(projectName) }).click();
  await expect(page.getByRole("heading", { level: 1, name: projectName })).toBeVisible();
}

async function openMembers(page: Page, count: number) {
  await page.getByRole("link", { name: `メンバー ${count}人` }).click();
  await expect(page.getByRole("heading", { level: 1, name: "メンバー" })).toBeVisible();
}

/** 山田が自分の案件を作り、メンバー管理を開く */
async function startInNewProject(page: Page, name: string) {
  await devLogin(page, "山田 太郎");
  await expectHeaderUser(page, "山田 太郎");
  await createProject(page, name);
  await openMembers(page, 1);
}

async function invite(page: Page, query: string, name: string, role?: string) {
  await page.getByRole("button", { name: "+ メンバーを招待" }).click();
  const dialog = page.getByRole("dialog", { name: "メンバーを招待" });
  await dialog.getByRole("searchbox", { name: "名前またはメールで検索" }).fill(query);
  await dialog.getByRole("radio", { name: new RegExp(name) }).check();
  if (role) await dialog.getByRole("combobox", { name: "役割" }).selectOption({ label: role });
  await dialog.getByRole("button", { name: "招待", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

const memberRow = (page: Page, name: string) => page.getByRole("row", { name: new RegExp(name) });
const roleSelect = (page: Page, name: string) =>
  page.getByRole("combobox", { name: `${name}の役割` });

test.describe("表の表示", () => {
  test("オーナー、編集者、閲覧者の順で並び、自分・停止中を添える。最後のオーナーの操作は無効", async ({
    page,
  }) => {
    await devLogin(page, "山田 太郎");
    await openProject(page, "A社 DX提案");
    await openMembers(page, 3);
    const rows = page.getByRole("row");
    await expect(rows.nth(1)).toContainText("山田 太郎");
    await expect(rows.nth(1)).toContainText("(自分)");
    await expect(rows.nth(2)).toContainText("佐藤 花子");
    await expect(rows.nth(3)).toContainText("鈴木 一郎");
    await expect(rows.nth(3)).toContainText("(停止中)");
    await expect(rows.nth(3)).toContainText("suzuki@example.com");

    // 唯一のオーナー: 役割の変更と「外す」を無効にして理由を添える
    await expect(roleSelect(page, "山田 太郎")).toBeDisabled();
    await expect(memberRow(page, "山田 太郎").getByRole("button", { name: "外す" })).toBeDisabled();
    await expect(page.getByText("※ 無効: オーナーが1人以上必要です")).toBeVisible();
    await expect(roleSelect(page, "佐藤 花子")).toHaveValue("editor");
    await expect(roleSelect(page, "佐藤 花子")).toBeEnabled();
    await expect(page.getByRole("button", { name: "+ メンバーを招待" })).toBeVisible();

    await page.getByRole("link", { name: "← A社 DX提案" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "A社 DX提案" })).toBeVisible();
  });

  test("オーナー以外は読み取り専用で、役割は文字で出る", async ({ page }) => {
    await devLogin(page, "佐藤 花子");
    await openProject(page, "A社 DX提案");
    await openMembers(page, 3);
    await expect(page.getByRole("button", { name: "+ メンバーを招待" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "外す" })).toHaveCount(0);
    await expect(page.getByRole("combobox")).toHaveCount(0);
    await expect(memberRow(page, "山田 太郎")).toContainText("オーナー");
    await expect(memberRow(page, "佐藤 花子")).toContainText("編集者");
  });

  test("参加していない案件のメンバー管理は「見つからない」を出す", async ({ page, browser }) => {
    await devLogin(page, "山田 太郎");
    await openProject(page, "A社 DX提案");
    const path = new URL(page.url()).pathname;
    const other = await browser.newContext(CONTEXT);
    const tanaka = await other.newPage();
    await devLogin(tanaka, "田中 美咲");
    await tanaka.goto(`${path}/members`);
    await expect(tanaka.getByText("この案件は見つからないか、参加していません")).toBeVisible();
    await tanaka.getByRole("link", { name: "ホームへ" }).click();
    await expect(tanaka).toHaveURL("/");
    await other.close();
  });
});

test.describe("招待・役割の変更・外す", () => {
  test("招待の候補は有効な利用者だけで、招待するとメンバーに加わる。役割を変えられる", async ({
    page,
  }) => {
    await startInNewProject(page, "E2E メンバー: 招待");

    await page.getByRole("button", { name: "+ メンバーを招待" }).click();
    const dialog = page.getByRole("dialog", { name: "メンバーを招待" });
    await expect(dialog.getByRole("combobox", { name: "役割" })).toHaveValue("editor");
    await expect(dialog.getByRole("button", { name: "招待", exact: true })).toBeDisabled();
    const search = dialog.getByRole("searchbox", { name: "名前またはメールで検索" });
    // 停止中の鈴木・すでにメンバーの山田は候補に出ない
    await search.fill("鈴木");
    await expect(
      dialog.getByText("該当する利用者がいません。利用者の追加は管理者に依頼してください。"),
    ).toBeVisible();
    await search.fill("yamada");
    await expect(
      dialog.getByText("該当する利用者がいません。利用者の追加は管理者に依頼してください。"),
    ).toBeVisible();
    await search.fill("sato");
    await dialog.getByRole("radio", { name: /佐藤 花子/ }).check();
    await dialog.getByRole("button", { name: "招待", exact: true }).click();
    await expect(page.getByText("メンバーを招待しました").first()).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expect(memberRow(page, "佐藤 花子")).toContainText("sato@example.com");
    await expect(roleSelect(page, "佐藤 花子")).toHaveValue("editor");

    await roleSelect(page, "佐藤 花子").selectOption({ label: "閲覧者" });
    await expect(page.getByText("役割を変更しました").first()).toBeVisible();
    await expect(roleSelect(page, "佐藤 花子")).toHaveValue("viewer");

    // 招待された人は、次にホームを開くと案件が現れる
    await page.getByRole("link", { name: "← E2E メンバー: 招待" }).click();
    await expect(page.getByRole("link", { name: "メンバー 2人" })).toBeVisible();
  });

  test("メンバーを外すには確認が要る。外すと表から消える", async ({ page }) => {
    await startInNewProject(page, "E2E メンバー: 外す");
    await invite(page, "sato", "佐藤 花子");
    await memberRow(page, "佐藤 花子").getByRole("button", { name: "外す" }).click();
    await expect(page.getByText("佐藤 花子をこの案件から外します。")).toBeVisible();
    await page.getByRole("button", { name: "キャンセル" }).click();
    await expect(memberRow(page, "佐藤 花子")).toBeVisible();
    await memberRow(page, "佐藤 花子").getByRole("button", { name: "外す" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "外す" }).click();
    await expect(page.getByText("メンバーを外しました").first()).toBeVisible();
    await expect(memberRow(page, "佐藤 花子")).toHaveCount(0);
  });

  test("自分の役割を下げると確認の後に読み取り専用の表示になる。オーナーが2人なら最後のオーナーの無効化は外れる", async ({
    page,
  }) => {
    await startInNewProject(page, "E2E メンバー: 自分の役割");
    await invite(page, "sato", "佐藤 花子", "オーナー");
    await expect(roleSelect(page, "山田 太郎")).toBeEnabled();
    await expect(page.getByText("※ 無効: オーナーが1人以上必要です")).toHaveCount(0);

    await roleSelect(page, "山田 太郎").selectOption({ label: "編集者" });
    await expect(
      page.getByText("自分の役割を編集者に変えると、メンバーの管理ができなくなります。"),
    ).toBeVisible();
    // 取りやめると、元の役割のまま
    await page.getByRole("button", { name: "キャンセル" }).click();
    await expect(roleSelect(page, "山田 太郎")).toHaveValue("owner");

    await roleSelect(page, "山田 太郎").selectOption({ label: "編集者" });
    await page.getByRole("dialog").getByRole("button", { name: "変更する" }).click();
    await expect(page.getByText("役割を変更しました").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "+ メンバーを招待" })).toHaveCount(0);
    await expect(page.getByRole("combobox")).toHaveCount(0);
    await expect(memberRow(page, "山田 太郎")).toContainText("編集者");
  });

  test("自分を外すとホームへ戻り、その案件は一覧から消える", async ({ page }) => {
    await startInNewProject(page, "E2E メンバー: 自分を外す");
    await invite(page, "sato", "佐藤 花子", "オーナー");
    await memberRow(page, "山田 太郎").getByRole("button", { name: "外す" }).click();
    await expect(page.getByText("自分をこの案件から外します。")).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "外す" }).click();
    await expect(page).toHaveURL("/");
    await expect(page.getByRole("row", { name: /E2E メンバー: 自分を外す/ })).toHaveCount(0);
  });

  test("役割の変更が失敗したら通知で理由を出し、プルダウンは元の値に戻る", async ({ page }) => {
    await startInNewProject(page, "E2E メンバー: 失敗");
    await invite(page, "sato", "佐藤 花子");
    await page.route("**/api/projects/*/members/*", (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill({
            status: 403,
            json: { error: { code: "ROLE_INSUFFICIENT", message: "x" } },
          })
        : route.continue(),
    );
    await roleSelect(page, "佐藤 花子").selectOption({ label: "閲覧者" });
    await expect(
      page.getByText("役割が変更されたため、この操作はできません").first(),
    ).toBeVisible();
    await expect(roleSelect(page, "佐藤 花子")).toHaveValue("editor");

    // すでに外されていた: 通知して、表を読み直す
    await page.unroute("**/api/projects/*/members/*");
    await page.route("**/api/projects/*/members/*", (route) =>
      route.request().method() === "DELETE"
        ? route.fulfill({
            status: 404,
            json: { error: { code: "MEMBER_NOT_FOUND", message: "x" } },
          })
        : route.continue(),
    );
    await memberRow(page, "佐藤 花子").getByRole("button", { name: "外す" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "外す" }).click();
    await expect(page.getByText("このメンバーはすでに外されています").first()).toBeVisible();
  });

  test("招待しようとした人がすでにメンバーだったら、入力を保ったまま理由を出す", async ({
    page,
  }) => {
    await startInNewProject(page, "E2E メンバー: 重複招待");
    await page.getByRole("button", { name: "+ メンバーを招待" }).click();
    const dialog = page.getByRole("dialog", { name: "メンバーを招待" });
    await dialog.getByRole("searchbox", { name: "名前またはメールで検索" }).fill("sato");
    await dialog.getByRole("radio", { name: /佐藤 花子/ }).check();
    await page.route("**/api/projects/*/members", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({
            status: 409,
            json: { error: { code: "ALREADY_MEMBER", message: "x" } },
          })
        : route.continue(),
    );
    await dialog.getByRole("button", { name: "招待", exact: true }).click();
    await expect(dialog.getByText("佐藤 花子さんはすでにメンバーです")).toBeVisible();
    await expect(dialog).toBeVisible();
  });
});

test.describe("モバイル", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("URL で直接開くと、パソコンで開くよう案内する", async ({ page }) => {
    await devLogin(page, "山田 太郎");
    await openProject(page, "A社 DX提案");
    await expect(page.getByRole("link", { name: /メンバー/ })).toHaveCount(0);
    const path = new URL(page.url()).pathname;
    await page.goto(`${path}/members`);
    await expect(page.getByText("この画面はパソコンで開いてください")).toBeVisible();
    await expect(page.getByRole("table")).toHaveCount(0);
    await page.getByRole("link", { name: "ホームへ" }).click();
    await expect(page).toHaveURL("/");
  });
});
