import { expect, type Page, test } from "@playwright/test";
import { devLogin, expectHeaderUser } from "./helpers";

// コアフロー「探して開く」(design-spec 2.2)。受入スイートを兼ねるので、実装の内部でなく振る舞いで書く

async function openProject(page: Page, projectName: string) {
  await page.getByRole("row", { name: new RegExp(projectName) }).click();
  await expect(page.getByRole("heading", { level: 1, name: projectName })).toBeVisible();
}

async function openDxProject(page: Page, user = "山田 太郎") {
  await devLogin(page, user);
  await expectHeaderUser(page, user);
  await openProject(page, "A社 DX提案");
}

test.describe("ホーム", () => {
  test("参加している案件が、役割・資料数・最終更新つきで新しい順に並ぶ", async ({ page }) => {
    await devLogin(page, "山田 太郎");
    const rows = page.getByRole("row");
    await expect(rows.nth(1)).toContainText("A社 DX提案");
    await expect(rows.nth(1)).toContainText("オーナー");
    await expect(rows.nth(1)).toContainText("5");
    await expect(rows.nth(1)).toContainText("2026/09/28");
    await expect(rows.nth(2)).toContainText("B社 市場調査");
    await expect(rows.nth(2)).toContainText("編集者");
    await expect(rows.nth(3)).toContainText("社内テンプレート集");
    await expect(rows.nth(3)).toContainText("閲覧者");
    // 削除済みの案件は出ない
    await expect(page.getByText("C社 業務改善")).toHaveCount(0);
  });

  test("参加している案件が0件なら案内を出す", async ({ page }) => {
    // 鈴木は停止中なので使えない。まだ案件を持たない利用者は、開発用ログインに出ない新規ユーザー
    await page.route("**/api/projects", (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ json: { projects: [] } })
        : route.continue(),
    );
    await devLogin(page, "佐藤 花子");
    await expect(page.getByText("まだ参加している案件がありません")).toBeVisible();
    await expect(page.getByText("招待されると、ここに案件が表示されます")).toBeVisible();
    await expect(page.getByRole("button", { name: "+ 案件を作る" }).first()).toBeVisible();
  });

  test("読み込みに失敗したら再読み込みで取り直せる", async ({ page }) => {
    let fail = true;
    await page.route("**/api/projects", (route) => {
      if (route.request().method() !== "GET") return route.continue();
      return fail ? route.fulfill({ status: 500, json: {} }) : route.continue();
    });
    await devLogin(page, "山田 太郎");
    await expect(page.getByText("読み込めませんでした")).toBeVisible();
    fail = false;
    await page.getByRole("button", { name: "再読み込み" }).click();
    await expect(page.getByRole("row", { name: /A社 DX提案/ })).toBeVisible();
  });
});

test.describe("探して開く", () => {
  test("案件の表に、タグ・旧版の件数・種別・登録した人が並ぶ", async ({ page }) => {
    await openDxProject(page);
    await expect(page.getByText("5件")).toBeVisible();
    const proposal = page.getByRole("row", { name: /提案書 v3/ });
    await expect(proposal).toContainText("確認済");
    await expect(proposal).toContainText("提出 v2");
    await expect(proposal).toContainText("+1");
    await expect(proposal).toContainText("旧版 2件");
    await expect(proposal).toContainText("スライド");
    await expect(proposal).toContainText("2026/09/28");
    await expect(proposal).toContainText("山田 太郎");
    await expect(page.getByRole("row", { name: /見積書/ })).toContainText("確定");
    await expect(page.getByRole("row", { name: /見積書/ })).toContainText("旧版 1件");
    await expect(page.getByRole("link", { name: "メンバー 3人" })).toBeVisible();
  });

  test("行を選ぶと横パネルが開き、版・参考資料・参考にした資料をたどれて、Esc で閉じる", async ({
    page,
  }) => {
    await openDxProject(page);
    await page.getByRole("row", { name: /提案書 v3/ }).click();
    const panel = page.getByRole("region", { name: "資料の詳細" });
    await expect(panel.getByRole("heading", { name: "提案書 v3" })).toBeVisible();
    await expect(page).toHaveURL(/series=.+&doc=|doc=.+&series=/);
    await expect(panel).toContainText("v3(最新)");
    await expect(panel).toContainText("A社の指摘を反映");
    // 開くは元の場所を別タブで開く
    const open = panel.getByRole("link", { name: /開く/ });
    await expect(open).toHaveAttribute("target", "_blank");
    // 版
    await expect(panel.getByRole("button", { name: /v2.*提案書 v2.*価格表を追加/ })).toBeVisible();
    await expect(panel.getByRole("button", { name: /v1.*提案書 初稿/ })).toBeVisible();
    // 参考資料
    await expect(panel.getByRole("button", { name: /調査レポート/ })).toBeVisible();
    await expect(
      panel.getByRole("button", { name: /提案テンプレート.*\(社内テンプレート集\)/ }),
    ).toBeVisible();
    // この資料を参考にした資料
    await expect(panel.getByRole("button", { name: /見積書.*この資料の v1 を参考/ })).toBeVisible();
    await expect(
      panel.getByRole("button", {
        name: /提案書\(B社向け\).*\(B社 市場調査\).*この資料の v2 を参考/,
      }),
    ).toBeVisible();

    // 版を切り替える。表の行は系列のまま
    await panel.getByRole("button", { name: /v2.*提案書 v2/ }).click();
    await expect(panel.getByRole("heading", { name: "提案書 v2" })).toBeVisible();
    await expect(panel).toContainText("価格表を追加");
    await expect(page.getByRole("row", { name: /提案書 v3/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // 同じ案件の参考資料を押すと、横パネルがその資料に切り替わる
    await panel.getByRole("button", { name: /調査レポート/ }).click();
    await expect(panel.getByRole("heading", { name: "調査レポート" })).toBeVisible();
    await expect(page.getByRole("row", { name: /調査レポート/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(page).not.toHaveURL(/series=/);
  });

  test("他の案件の資料を押すとその案件へ移り、その資料を選んだ状態で開く", async ({ page }) => {
    await openDxProject(page);
    await page.getByRole("row", { name: /提案書 v3/ }).click();
    await page
      .getByRole("region", { name: "資料の詳細" })
      .getByRole("button", { name: /提案書\(B社向け\)/ })
      .click();
    await expect(page.getByRole("heading", { level: 1, name: "B社 市場調査" })).toBeVisible();
    await expect(
      page.getByRole("region", { name: "資料の詳細" }).getByRole("heading", {
        name: "提案書(B社向け)",
      }),
    ).toBeVisible();
  });

  test("行にマウスを載せると「開く ↗」が出て、押しても横パネルは開かない", async ({ page }) => {
    await openDxProject(page);
    const row = page.getByRole("row", { name: /調査レポート/ });
    await row.hover();
    const open = row.getByRole("link", { name: /開く/ });
    await expect(open).toBeVisible();
    await expect(open).toHaveAttribute("target", "_blank");
    const popup = page.waitForEvent("popup");
    await open.click();
    await (await popup).close();
    await expect(page.getByRole("region", { name: "資料の詳細" })).toHaveCount(0);
  });

  test("「旧版 n件」を押すとその系列を選んで横パネルを開く", async ({ page }) => {
    await openDxProject(page);
    await page.getByRole("button", { name: "旧版 2件" }).click();
    const panel = page.getByRole("region", { name: "資料の詳細" });
    await expect(panel.getByRole("heading", { name: "提案書 v3" })).toBeVisible();
    await expect(panel.getByRole("heading", { name: "版" })).toBeInViewport();
  });

  test("横パネルが開いている間は表が資料名と更新の2列になり、タグは1つと「+n」", async ({
    page,
  }) => {
    await openDxProject(page);
    await page.getByRole("row", { name: /提案書 v3/ }).click();
    await expect(page.getByRole("columnheader")).toHaveText([/資料名/, /更新/]);
    const row = page.getByRole("row", { name: /提案書 v3/ });
    await expect(row).toContainText("確認済");
    await expect(row).toContainText("+2");
    await row.getByRole("button", { name: "+2" }).hover();
    await expect(page.getByText("提出 v2").last()).toBeVisible();
  });

  test("絞り込みと種別フィルタ。旧版の名前にも一致し、0件なら解除できる", async ({ page }) => {
    await openDxProject(page);
    await page.getByRole("searchbox", { name: "資料名で絞り込み" }).fill("提案書 初稿");
    await expect(page.getByText("1件")).toBeVisible();
    await expect(page.getByRole("row", { name: /提案書 v3/ })).toBeVisible();
    await page.getByRole("searchbox", { name: "資料名で絞り込み" }).fill("存在しない資料");
    await expect(page.getByText("条件に合う資料がありません")).toBeVisible();
    await page.getByRole("button", { name: "絞り込みを解除" }).click();
    await expect(page.getByText("5件")).toBeVisible();
    await page.getByLabel("種別").selectOption({ label: "PDF" });
    await expect(page.getByText("1件")).toBeVisible();
    await expect(page.getByRole("row", { name: /議事録 9\/15/ })).toBeVisible();
  });

  test("列見出しで並べ替え、もう一度押すと逆順になる", async ({ page }) => {
    await openDxProject(page);
    const names = page.getByRole("row").filter({ hasNot: page.getByRole("columnheader") });
    await expect(names.first()).toContainText("提案書 v3");
    await page.getByRole("button", { name: "更新で並べ替え" }).click();
    await expect(names.first()).toContainText("業界ニュースまとめ");
  });

  test("選んだ系列と版は URL で復元できる", async ({ page }) => {
    await openDxProject(page);
    await page.getByRole("row", { name: /提案書 v3/ }).click();
    await page
      .getByRole("region", { name: "資料の詳細" })
      .getByRole("button", { name: /v1.*提案書 初稿/ })
      .click();
    await expect(page.getByRole("region", { name: "資料の詳細" })).toContainText("提案書 初稿");
    await page.reload();
    const panel = page.getByRole("region", { name: "資料の詳細" });
    await expect(panel.getByRole("heading", { name: "提案書 初稿" })).toBeVisible();
    await expect(page.getByRole("row", { name: /提案書 v3/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  test("URL で指定された系列が無いときは横パネルを開かず、通知する", async ({ page }) => {
    await devLogin(page, "山田 太郎");
    await openProject(page, "A社 DX提案");
    const url = new URL(page.url());
    await page.goto(
      `${url.pathname}?series=00000000-0000-4000-8000-000000000000&doc=00000000-0000-4000-8000-000000000001`,
    );
    await expect(page.getByText("この資料は削除されたか、見つかりません").first()).toBeVisible();
    await expect(page.getByRole("region", { name: "資料の詳細" })).toHaveCount(0);
    await expect(page.getByRole("row", { name: /提案書 v3/ })).toBeVisible();
    await expect(page).not.toHaveURL(/series=/);
  });

  test("URL で指定された版だけが無いときも、横パネルは開かず通知する", async ({ page }) => {
    await openDxProject(page);
    await page.getByRole("row", { name: /提案書 v3/ }).click();
    const series = new URL(page.url()).searchParams.get("series");
    await page.goto(
      `${new URL(page.url()).pathname}?series=${series}&doc=00000000-0000-4000-8000-000000000001`,
    );
    await expect(page.getByText("この資料は削除されたか、見つかりません").first()).toBeVisible();
    await expect(page.getByRole("region", { name: "資料の詳細" })).toHaveCount(0);
    await expect(page).not.toHaveURL(/series=/);
  });

  test("横パネルを表示した後に選んでいた版が削除されたら、系列の最新版に切り替える", async ({
    page,
  }) => {
    await openDxProject(page);
    await page.getByRole("row", { name: /提案書 v3/ }).click();
    const panel = page.getByRole("region", { name: "資料の詳細" });
    await expect(panel.getByRole("heading", { name: "提案書 v3" })).toBeVisible();
    // 他の人が v2 を削除した状況: v2 を指定した詳細の取得だけが「見つからない」になる
    await page.route("**/api/series/*?documentId=*", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const v2 = body.versions.find((v: { versionNo: number }) => v.versionNo === 2);
      if (v2 && route.request().url().includes(v2.id)) {
        await route.fulfill({
          status: 404,
          json: { error: { code: "DOCUMENT_NOT_FOUND", details: { seriesExists: true } } },
        });
      } else {
        await route.fulfill({ response });
      }
    });
    await panel.getByRole("button", { name: /v2.*提案書 v2/ }).click();
    await expect(panel.getByRole("heading", { name: "提案書 v3" })).toBeVisible();
    await expect(panel).toContainText("v3(最新)");
    await expect(page.getByRole("row", { name: /提案書 v3/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  test("参加していない・存在しない案件は「見つからない」を画面全体に出す", async ({ page }) => {
    await devLogin(page, "山田 太郎");
    await page.goto("/projects/00000000-0000-4000-8000-000000000000");
    await expect(page.getByText("この案件は見つからないか、参加していません")).toBeVisible();
    await page.getByRole("link", { name: "ホームへ" }).click();
    await expect(page).toHaveURL("/");
  });

  test("資料の読み込みに失敗したら再読み込みで取り直せる", async ({ page }) => {
    await devLogin(page, "山田 太郎");
    let fail = true;
    await page.route("**/api/projects/*/series", (route) =>
      fail ? route.fulfill({ status: 500, json: {} }) : route.continue(),
    );
    await openProject(page, "A社 DX提案");
    await expect(page.getByText("資料を読み込めませんでした")).toBeVisible();
    fail = false;
    await page.getByRole("button", { name: "再読み込み" }).click();
    await expect(page.getByRole("row", { name: /提案書 v3/ })).toBeVisible();
  });
});

test.describe("関連資料の表示規則", () => {
  test("山田には、削除された案件の資料が「削除された資料」と出る", async ({ page }) => {
    await openDxProject(page, "山田 太郎");
    await page.getByRole("row", { name: /業界ニュースまとめ/ }).click();
    const panel = page.getByRole("region", { name: "資料の詳細" });
    await expect(panel.getByText("削除された資料")).toBeVisible();
    await expect(panel.getByText("現状分析")).toHaveCount(0);
  });

  test("佐藤には、参加していない案件の資料が「見る権限のない資料」と出る", async ({ page }) => {
    await openDxProject(page, "佐藤 花子");
    await page.getByRole("row", { name: /業界ニュースまとめ/ }).click();
    const panel = page.getByRole("region", { name: "資料の詳細" });
    await expect(panel.getByText("見る権限のない資料")).toBeVisible();
    await expect(panel.getByText("現状分析")).toHaveCount(0);
  });
});

test.describe("横断検索", () => {
  test("語を入れると結果が出て、旧版には「旧版」が付き、行を押すとその版を表示した案件画面へ移る", async ({
    page,
  }) => {
    await devLogin(page, "山田 太郎");
    await page.getByRole("searchbox", { name: "資料を検索" }).fill("提案書");
    await expect(page).toHaveURL(/\?q=%E6%8F%90%E6%A1%88%E6%9B%B8$/);
    await expect(page.getByText("「提案書」の検索結果 4件")).toBeVisible();
    const old = page.getByRole("row", { name: /提案書 v2/ });
    await expect(old).toContainText("旧版");
    await expect(old).toContainText("A社 DX提案");
    await expect(old).toContainText("スライド");
    await expect(page.getByRole("row", { name: /提案書\(B社向け\)/ })).toContainText(
      "ドキュメント",
    );
    await old.click();
    await expect(page.getByRole("heading", { level: 1, name: "A社 DX提案" })).toBeVisible();
    await expect(
      page.getByRole("region", { name: "資料の詳細" }).getByRole("heading", { name: "提案書 v2" }),
    ).toBeVisible();
  });

  test("入力の途中で URL に反映されても、入力した文字は消えない", async ({ page }) => {
    await devLogin(page, "山田 太郎");
    const box = page.getByRole("searchbox", { name: "資料を検索" });
    await box.pressSequentially("提案書 v", { delay: 150 });
    await page.waitForTimeout(600);
    await box.pressSequentially("3", { delay: 150 });
    await expect(box).toHaveValue("提案書 v3");
    await expect(page.getByText("「提案書 v3」の検索結果 1件")).toBeVisible();
  });

  test("一致が無ければその旨を出し、「×」で案件一覧に戻る", async ({ page }) => {
    await devLogin(page, "山田 太郎");
    await page.getByRole("searchbox", { name: "資料を検索" }).fill("zzzz");
    await expect(page.getByText("「zzzz」に一致する資料はありません")).toBeVisible();
    await page.getByRole("button", { name: "検索を消去" }).click();
    await expect(page.getByRole("row", { name: /A社 DX提案/ })).toBeVisible();
    await expect(page).toHaveURL("/");
  });

  test("検索結果の行に「開く ↗」が出る。?q= で直接開いても検索される", async ({ page }) => {
    await devLogin(page, "山田 太郎");
    await page.goto("/?q=調査");
    await expect(page.getByRole("searchbox", { name: "資料を検索" })).toHaveValue("調査");
    const row = page.getByRole("row", { name: /調査レポート/ });
    await row.hover();
    await expect(row.getByRole("link", { name: /開く/ })).toBeVisible();
  });
});

test.describe("案件の作成・名前の変更・削除", () => {
  test("案件を作るとその案件画面へ移り、ホームの一覧に出る", async ({ page }) => {
    await devLogin(page, "山田 太郎");
    await page.getByRole("button", { name: "+ 案件を作る" }).click();
    const dialog = page.getByRole("dialog", { name: "案件を作る" });
    await expect(dialog.getByRole("button", { name: "作成" })).toBeDisabled();
    await dialog.getByRole("textbox", { name: "案件名" }).fill("   ");
    await expect(dialog.getByText("入力してください")).toBeVisible();
    await dialog.getByRole("textbox", { name: "案件名" }).fill("あ".repeat(101));
    await expect(dialog.getByText("100文字以内で入力してください")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "作成" })).toBeDisabled();
    await dialog.getByRole("textbox", { name: "案件名" }).fill("E2E 新規案件");
    await dialog.getByRole("button", { name: "作成" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "E2E 新規案件" })).toBeVisible();
    await expect(page.getByText("案件を作成しました").first()).toBeVisible();
    await expect(page.getByText("まだ資料がありません")).toBeVisible();
    await page.getByRole("link", { name: "← ホーム" }).click();
    await expect(page.getByRole("row", { name: /E2E 新規案件/ })).toContainText("オーナー");
  });

  test("オーナーは案件名を変更して削除できる。編集者以下にはメニューを出さない", async ({
    page,
  }) => {
    await devLogin(page, "山田 太郎");
    await page.getByRole("button", { name: "+ 案件を作る" }).click();
    await page.getByRole("textbox", { name: "案件名" }).fill("削除用の案件");
    await page.getByRole("button", { name: "作成" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "削除用の案件" })).toBeVisible();

    await page.getByRole("button", { name: "案件のメニュー" }).click();
    await page.getByRole("menuitem", { name: "案件名を変更" }).click();
    await page.getByRole("textbox", { name: "案件名" }).fill("名前を変えた案件");
    await page.getByRole("button", { name: "保存" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "名前を変えた案件" })).toBeVisible();
    await expect(page.getByText("案件名を変更しました").first()).toBeVisible();

    await page.getByRole("button", { name: "案件のメニュー" }).click();
    await page.getByRole("menuitem", { name: "案件を削除" }).click();
    await expect(
      page.getByText(
        "『名前を変えた案件』を削除します。資料の記録は一覧と検索から消えます。元の場所にあるファイルは消えません。",
      ),
    ).toBeVisible();
    await page.getByRole("button", { name: "削除", exact: true }).click();
    await expect(page).toHaveURL("/");
    await expect(page.getByText("案件を削除しました").first()).toBeVisible();
    await expect(page.getByRole("row", { name: /名前を変えた案件/ })).toHaveCount(0);
  });

  test("オーナーでない案件には「⋯」を出さない", async ({ page }) => {
    await devLogin(page, "山田 太郎");
    await openProject(page, "B社 市場調査");
    await expect(page.getByRole("link", { name: "メンバー 3人" })).toBeVisible();
    await expect(page.getByRole("button", { name: "案件のメニュー" })).toHaveCount(0);
  });
});

test.describe("モバイル", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("ホームは案件名と最終更新の2列で、案件を作るを出さない", async ({ page }) => {
    await devLogin(page, "山田 太郎");
    await expect(page.getByRole("columnheader")).toHaveText([/案件名/, /最終更新/]);
    await expect(page.getByRole("button", { name: "+ 案件を作る" })).toHaveCount(0);
    await page.getByRole("searchbox", { name: "資料を検索" }).fill("提案書");
    await expect(page.getByRole("columnheader")).toHaveText([/資料名/, /更新/]);
  });

  test("案件は資料名と更新の2列で、行を押すと全画面のシートが開く。変更系の操作は出さない", async ({
    page,
  }) => {
    await devLogin(page, "山田 太郎");
    await openProject(page, "A社 DX提案");
    await expect(page.getByRole("columnheader")).toHaveText([/資料名/, /更新/]);
    await expect(page.getByRole("link", { name: /メンバー/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "案件のメニュー" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "旧版 2件" })).toHaveCount(0);
    await page.getByRole("row", { name: /提案書 v3/ }).click();
    const sheet = page.getByRole("region", { name: "資料の詳細" });
    await expect(sheet.getByRole("heading", { name: "提案書 v3" })).toBeVisible();
    await expect(sheet.getByRole("link", { name: /開く/ })).toBeVisible();
    await expect(sheet.getByRole("button", { name: /新しい版|これを元に|削除/ })).toHaveCount(0);
    const box = await sheet.locator("..").boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(389);
  });
});

test.describe("メタデータの取り直し", () => {
  test("連携中の人が案件を開くと、表を出した後に取り直しを呼ぶ", async ({ page }) => {
    await devLogin(page, "山田 太郎");
    const refresh = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        /\/api\/projects\/[^/]+\/metadata-refresh$/.test(request.url()),
    );
    await openProject(page, "A社 DX提案");
    await refresh;
    await expect(page.getByRole("row", { name: /提案書 v3/ })).toBeVisible();
  });

  test("要再連携の人が開いたときは取り直さない", async ({ page }) => {
    let called = false;
    page.on("request", (request) => {
      if (request.url().endsWith("/metadata-refresh")) called = true;
    });
    await devLogin(page, "田中 美咲");
    await openProject(page, "B社 市場調査");
    await expect(page.getByRole("row", { name: /競合比較/ })).toBeVisible();
    expect(called).toBe(false);
  });
});

test.describe("タブレットと英語", () => {
  test("タブレットの幅でも横パネルが開く", async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 900 });
    await openDxProject(page);
    await expect(page.getByRole("button", { name: "案件のメニュー" })).toBeVisible();
    await page.getByRole("row", { name: /提案書 v3/ }).click();
    const panel = page.getByRole("region", { name: "資料の詳細" });
    await expect(panel.getByRole("heading", { name: "提案書 v3" })).toBeVisible();
    await panel.getByRole("button", { name: "閉じる" }).click();
    await expect(panel).toHaveCount(0);
  });

  test("英語では英語の文言と単数・複数で表示する", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "English" }).click();
    await page.getByRole("button", { name: /山田 太郎/ }).click();
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    await openProject(page, "A社 DX提案");
    await expect(page.getByRole("link", { name: "3 members" })).toBeVisible();
    await expect(page.getByRole("row", { name: /提案書 v3/ })).toContainText("2 older versions");
    await expect(page.getByRole("row", { name: /見積書/ })).toContainText("1 older version");
    await expect(page.getByText("5 documents")).toBeVisible();
    await page.getByRole("row", { name: /提案書 v3/ }).click();
    await expect(page.getByRole("region", { name: "Document details" })).toContainText(
      "v3 (Latest)",
    );
    await page.getByRole("button", { name: "User menu: 山田 太郎" }).click();
    await page.getByRole("menuitemradio", { name: "日本語" }).click();
  });
});
