import { expect, test } from "@playwright/test";
import {
  addButton,
  addDialog,
  createDocument,
  createProject,
  devLogin,
  panel,
  registerByLink,
  startInNewProject,
} from "./helpers";

// コアフロー「作る・記録する」(design-spec 2.2、6.2、6.3)。
// 作ったものが他のテストのデータ(シードの件数・並び)を変えないよう、各テストは自分の案件の中で操作する

const GUIDANCE =
  "ドライブのファイル選択画面で選ぶと、アプリで資料名を読んだりコピーしたりできます。";

test.beforeEach(async ({ context }) => {
  // 作成後に開く編集画面(Google のダミー URL)へは実際につなげない
  await context.route("https://docs.google.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<title>editor</title>" }),
  );
});

test.describe("資料を追加: 新しく作る", () => {
  test("既定のタブで作り、行を選んで横パネルを開き、編集画面を別タブで開く", async ({
    page,
    context,
  }) => {
    await startInNewProject(page, "E2E 作成: 新しく作る");
    await addButton(page).click();
    const dialog = addDialog(page);
    await expect(dialog.getByRole("tab", { name: "新しく作る" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(
      dialog.getByText(
        "作成したファイルはマイドライブ直下に置かれます。置き場所と共有設定は、ドライブで変えてください。",
      ),
    ).toBeVisible();

    // 入力の不備: 空と上限
    const create = dialog.getByRole("button", { name: "作成" });
    await expect(create).toBeDisabled();
    const name = dialog.getByRole("textbox", { name: "資料名" });
    await name.fill("あ".repeat(201));
    await expect(dialog.getByText("200文字以内で入力してください")).toBeVisible();
    await expect(create).toBeDisabled();

    await dialog.getByRole("combobox", { name: "種別" }).selectOption("google_slides");
    await name.fill("調査メモ");
    const editor = context.waitForEvent("page");
    await create.click();
    expect((await editor).url()).toMatch(
      /^https:\/\/docs\.google\.com\/presentation\/d\/.+\/edit$/,
    );

    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("資料を作成しました").first()).toBeVisible();
    // ポップアップがブロックされた場合に備えて、通知にも同じリンクを添える
    await expect(page.getByRole("link", { name: "編集画面を開く ↗" })).toHaveAttribute(
      "href",
      /docs\.google\.com\/presentation/,
    );
    await expect(page.getByRole("row", { name: /調査メモ/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(panel(page).getByRole("heading", { name: "調査メモ" })).toBeVisible();
    await expect(panel(page)).toContainText("v1(最新)");
  });

  test("ドライブでの作成に失敗したら、入力を保ったまま理由を出す", async ({ page }) => {
    await startInNewProject(page, "E2E 作成: 失敗");
    await page.route("**/api/projects/*/documents/new", (route) =>
      route.fulfill({
        status: 502,
        json: { error: { code: "DRIVE_CREATE_FAILED", message: "x" } },
      }),
    );
    await addButton(page).click();
    const dialog = addDialog(page);
    await dialog.getByRole("textbox", { name: "資料名" }).fill("失敗する資料");
    await dialog.getByRole("button", { name: "作成" }).click();
    await expect(
      dialog.getByText("ドライブに資料を作れませんでした。もう一度お試しください。"),
    ).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "資料名" })).toHaveValue("失敗する資料");
  });

  test("ドライブには作れたが登録に失敗したら、リンクと「このリンクで登録」を出す", async ({
    page,
  }) => {
    await startInNewProject(page, "E2E 作成: 登録失敗");
    const url = "https://docs.google.com/document/d/created-but-lost/edit";
    await page.route("**/api/projects/*/documents/new", (route) =>
      route.fulfill({
        status: 500,
        json: {
          error: {
            code: "DRIVE_CREATED_NOT_REGISTERED",
            message: "x",
            details: {
              file: { fileId: "created-but-lost", url },
              cause: "internal",
              causeCode: "INTERNAL",
            },
          },
        },
      }),
    );
    await addButton(page).click();
    const dialog = addDialog(page);
    await dialog.getByRole("textbox", { name: "資料名" }).fill("登録に失敗した資料");
    await dialog.getByRole("button", { name: "作成" }).click();
    await expect(
      dialog.getByText("ドライブに資料は作成されましたが、登録できませんでした。"),
    ).toBeVisible();
    await expect(dialog.getByRole("link", { name: "作成したファイルを開く ↗" })).toHaveAttribute(
      "href",
      url,
    );
    await dialog.getByRole("button", { name: "このリンクで登録" }).click();
    await expect(dialog.getByRole("tab", { name: "リンクで登録" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(dialog.getByRole("textbox", { name: "リンク" })).toHaveValue(url);
    await expect(dialog.getByRole("textbox", { name: "資料名" })).toHaveValue("登録に失敗した資料");
  });
});

test.describe("資料を追加: リンクで登録", () => {
  test("アプリがまだ使えないファイルは、ファイル選択画面で選ぶと名前を自動で取れる。参考資料も付けられる", async ({
    page,
  }) => {
    await startInNewProject(page, "E2E 作成: リンク");
    await addButton(page).click();
    const dialog = addDialog(page);
    await dialog.getByRole("tab", { name: "リンクで登録" }).click();
    await dialog
      .getByRole("textbox", { name: "リンク" })
      .fill("https://docs.google.com/presentation/d/seed-template/edit");
    // 貼った時点の種別の判定
    await expect(dialog.getByRole("combobox", { name: "種別" })).toHaveValue("google_slides");

    // 提案テンプレートは田中が登録した資料で、山田のアプリはまだ使えない(design-spec 6.0.9)
    await expect(
      dialog.getByText(
        "ドライブのファイル選択画面で選ぶと、アプリで資料名を読んだりコピーしたりできます。",
      ),
    ).toBeVisible();
    await expect(
      dialog.getByText(
        "ファイル選択画面に出てこない場合は、そのファイルを見る権限がありません。ドライブの共有を確かめてください。",
      ),
    ).toBeVisible();
    // 案内を無視して手入力で続けられる
    await expect(dialog.getByRole("textbox", { name: "資料名" })).toBeEditable();

    await dialog.getByRole("button", { name: "このファイルをアプリで使えるようにする" }).click();
    const picker = page.getByRole("dialog", { name: "ドライブのファイルを選ぶ" });
    // 1ファイルだけを見せた状態で開く
    await expect(picker.getByRole("button")).toHaveCount(2); // 提案テンプレート と キャンセル
    await picker.getByRole("button", { name: "提案テンプレート" }).click();

    const name = dialog.getByRole("textbox", { name: "資料名" });
    await expect(name).toHaveValue("提案テンプレート");
    await expect(name).not.toBeEditable();
    await expect(dialog.getByText("ドライブの名前を使います")).toBeVisible();
    await expect(dialog.getByText("2026/08/30")).toBeVisible();

    // 参考資料: 名前で検索して候補から選ぶ。×で外せる
    const references = dialog.getByRole("searchbox", { name: "参考資料" });
    await references.fill("調査");
    await dialog.getByRole("button", { name: /調査レポート.*A社 DX提案/ }).click();
    await expect(dialog.getByRole("button", { name: "調査レポート を外す" })).toBeVisible();

    await dialog.getByRole("button", { name: "追加" }).click();
    await expect(page.getByText("資料を追加しました").first()).toBeVisible();
    await expect(page.getByRole("row", { name: /提案テンプレート/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(panel(page)).toContainText("調査レポート");
    await expect(panel(page)).toContainText("(A社 DX提案)");
  });

  test("ドライブ以外のリンクは、種別を判定し、名前と更新日を手で入れる。未来の日付は選べない", async ({
    page,
  }) => {
    await startInNewProject(page, "E2E 作成: 手入力");
    await addButton(page).click();
    const dialog = addDialog(page);
    await dialog.getByRole("tab", { name: "リンクで登録" }).click();
    const add = dialog.getByRole("button", { name: "追加" });
    await expect(add).toBeDisabled();

    const url = dialog.getByRole("textbox", { name: "リンク" });
    await url.fill("ftp://example.com/report.pdf");
    await expect(
      dialog.getByText("http または https で始まるリンクを入力してください"),
    ).toBeVisible();
    await url.fill("https://example.com/report.pdf");
    await expect(dialog.getByRole("combobox", { name: "種別" })).toHaveValue("pdf");

    await dialog.getByRole("textbox", { name: "資料名" }).fill("調査レポート(外部)");
    const date = dialog.getByLabel("更新日時");
    await expect(date).toHaveAttribute("max", /^\d{4}-\d{2}-\d{2}$/);
    await date.fill("2999-01-01");
    await expect(dialog.getByText("未来の日時は指定できません")).toBeVisible();
    await expect(add).toBeDisabled();
    await date.fill("2026-09-10");
    await add.click();

    await expect(panel(page)).toContainText("PDF");
    await expect(page.getByRole("row", { name: /調査レポート\(外部\)/ })).toContainText(
      "2026/09/10",
    );
  });

  test("同じ案件に同じリンクがあれば追加せず、その資料を選べる", async ({ page }) => {
    await startInNewProject(page, "E2E 作成: 重複");
    const link = "https://example.com/dup.pdf";
    for (const name of ["最初の資料", "重複する資料"]) {
      await addButton(page).click();
      const dialog = addDialog(page);
      await dialog.getByRole("tab", { name: "リンクで登録" }).click();
      await dialog.getByRole("textbox", { name: "リンク" }).fill(link);
      await dialog.getByRole("textbox", { name: "資料名" }).fill(name);
      await dialog.getByRole("button", { name: "追加" }).click();
      if (name === "最初の資料") {
        await expect(dialog).toHaveCount(0);
        await page.keyboard.press("Escape");
        continue;
      }
      await expect(
        dialog.getByText("この案件には同じリンクの資料がすでにあります: 最初の資料"),
      ).toBeVisible();
      // 入力は保たれる
      await expect(dialog.getByRole("textbox", { name: "リンク" })).toHaveValue(link);
      await dialog.getByRole("button", { name: "この資料を選ぶ" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(panel(page).getByRole("heading", { name: "最初の資料" })).toBeVisible();
    }
  });

  test("「ドライブから選ぶ」で選ぶと、リンク・資料名・種別が入る", async ({ page }) => {
    await startInNewProject(page, "E2E 作成: ドライブから選ぶ");
    await addButton(page).click();
    const dialog = addDialog(page);
    await dialog.getByRole("tab", { name: "リンクで登録" }).click();
    await dialog.getByRole("button", { name: "ドライブから選ぶ" }).click();
    await page
      .getByRole("dialog", { name: "ドライブのファイルを選ぶ" })
      .getByRole("button", { name: "競合比較" })
      .click();
    await expect(dialog.getByRole("textbox", { name: "リンク" })).toHaveValue(
      "https://docs.google.com/spreadsheets/d/seed-competitors/edit",
    );
    await expect(dialog.getByRole("textbox", { name: "資料名" })).toHaveValue("競合比較");
    await expect(dialog.getByRole("combobox", { name: "種別" })).toHaveValue("google_sheets");
  });
});

test.describe("これを元に作る・新しい版を作る・版の削除", () => {
  test("これを元に作る: 別の案件へ作ると、通知のリンクでその案件の資料を開ける", async ({
    page,
  }) => {
    await startInNewProject(page, "E2E コピー先");
    await page.getByRole("link", { name: "← ホーム" }).click();
    await createProject(page, "E2E コピー元");
    await createDocument(page, "コピーされる資料");

    await panel(page).getByRole("button", { name: "これを元に作る" }).click();
    const dialog = page.getByRole("dialog", { name: "これを元に作る" });
    await expect(dialog).toContainText("元の資料:");
    await expect(dialog).toContainText("コピーされる資料 v1(E2E コピー元)");
    const name = dialog.getByRole("textbox", { name: "資料名" });
    await expect(name).toHaveValue("コピーされる資料 のコピー");
    const target = dialog.getByRole("combobox", { name: "追加先の案件" });
    await expect(target.locator("option:checked")).toHaveText("E2E コピー元");
    // 追加先は自分が編集者以上の案件(閲覧者の「社内テンプレート集」は出ない)
    await expect(target.locator("option", { hasText: "社内テンプレート集" })).toHaveCount(0);
    await target.selectOption({ label: "E2E コピー先" });
    await dialog.getByRole("button", { name: "作成" }).click();

    await expect(page.getByText("E2E コピー先 に作成しました").first()).toBeVisible();
    // 今の画面に留まる
    await expect(page.getByRole("heading", { level: 1, name: "E2E コピー元" })).toBeVisible();
    await page.getByRole("button", { name: "その案件の資料を開く" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "E2E コピー先" })).toBeVisible();
    await expect(
      panel(page).getByRole("heading", { name: "コピーされる資料 のコピー" }),
    ).toBeVisible();
    // 参考資料にコピー元の版が記録される
    await expect(panel(page)).toContainText("コピーされる資料");
    await expect(panel(page)).toContainText("(E2E コピー元)");
  });

  test("これを元に作る: 今の案件へ作ると、表に新しい行が出て選ばれる", async ({ page }) => {
    await startInNewProject(page, "E2E コピー: 同じ案件");
    await createDocument(page, "元の資料");
    await panel(page).getByRole("button", { name: "これを元に作る" }).click();
    const dialog = page.getByRole("dialog", { name: "これを元に作る" });
    await dialog.getByRole("textbox", { name: "資料名" }).fill("");
    await expect(dialog.getByText("入力してください")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "作成" })).toBeDisabled();
    await dialog.getByRole("textbox", { name: "資料名" }).fill("写し");
    await dialog.getByRole("button", { name: "作成" }).click();
    await expect(panel(page).getByRole("heading", { name: "写し" })).toBeVisible();
    await expect(page.getByRole("row", { name: /写し/ })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("row", { name: /元の資料/ })).toBeVisible();
  });

  test("これを元に作る: アプリがまだ使えないコピー元は、ファイル選択画面で選ぶまで作成を押せない", async ({
    page,
  }) => {
    await startInNewProject(page, "E2E コピー: 使えないファイル");
    // 研修カリキュラムは鈴木が登録した資料で、山田のアプリはまだ使えない(design-spec 6.0.9)
    await registerByLink(
      page,
      "https://docs.google.com/document/d/seed-training/edit",
      "手入力の研修資料",
    );
    await panel(page).getByRole("button", { name: "これを元に作る" }).click();
    const dialog = page.getByRole("dialog", { name: "これを元に作る" });
    await expect(dialog.getByText(GUIDANCE)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "作成" })).toBeDisabled();

    // 選ばずに閉じたら、案内を出したまま何も変わらない
    await dialog.getByRole("button", { name: "このファイルをアプリで使えるようにする" }).click();
    const picker = page.getByRole("dialog", { name: "ドライブのファイルを選ぶ" });
    await picker.getByRole("button", { name: "キャンセル" }).click();
    await expect(dialog.getByText(GUIDANCE)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "作成" })).toBeDisabled();

    await dialog.getByRole("button", { name: "このファイルをアプリで使えるようにする" }).click();
    await picker.getByRole("button", { name: "研修カリキュラム" }).click();
    await expect(dialog.getByText(GUIDANCE)).toHaveCount(0);
    await dialog.getByRole("button", { name: "作成" }).click();
    await expect(
      panel(page).getByRole("heading", { name: "手入力の研修資料 のコピー" }),
    ).toBeVisible();
  });

  test("新しい版を作る: ファイル選択画面で使えるようにしてから作ると、次の版になる", async ({
    page,
  }) => {
    await startInNewProject(page, "E2E 版: 使えないファイル");
    // 調査レポートは佐藤が登録した資料で、山田のアプリはまだ使えない
    await registerByLink(
      page,
      "https://docs.google.com/document/d/seed-survey/edit",
      "手入力の調査資料",
    );
    await panel(page).getByRole("button", { name: "新しい版を作る" }).click();
    const dialog = page.getByRole("dialog", { name: "新しい版を作る" });
    await expect(dialog.getByText(GUIDANCE)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "作成" })).toBeDisabled();
    await dialog.getByRole("button", { name: "このファイルをアプリで使えるようにする" }).click();
    await page
      .getByRole("dialog", { name: "ドライブのファイルを選ぶ" })
      .getByRole("button", { name: "調査レポート" })
      .click();
    await expect(dialog.getByText(GUIDANCE)).toHaveCount(0);
    await dialog.getByRole("button", { name: "作成" }).click();
    await expect(panel(page)).toContainText("v2(最新)");
    await expect(page.getByRole("row", { name: /手入力の調査資料/ })).toContainText("旧版 1件");
  });

  test("新しい版を作る → 旧版が増え、版を削除すると最新版が切り替わり、最後の1版で行が消える", async ({
    page,
  }) => {
    await startInNewProject(page, "E2E 版");
    await createDocument(page, "見積書", "google_slides");

    await panel(page).getByRole("button", { name: "新しい版を作る" }).click();
    const dialog = page.getByRole("dialog", { name: "新しい版を作る" });
    await expect(dialog.getByRole("textbox", { name: "資料名" })).toHaveValue("見積書");
    await expect(dialog.getByRole("combobox", { name: "追加先の案件" })).toHaveCount(0);
    await dialog.getByRole("textbox", { name: "変更メモ" }).fill("価格を更新");
    await dialog.getByRole("button", { name: "作成" }).click();

    await expect(panel(page)).toContainText("v2(最新)");
    await expect(panel(page)).toContainText("価格を更新");
    await expect(page.getByRole("row", { name: /見積書/ })).toContainText("旧版 1件");
    await expect(page.getByText("新しい版を作成しました").first()).toBeVisible();

    // 旧版を削除: 横パネルは最新版を表示し、旧版の件数が減る
    await panel(page)
      .getByRole("button", { name: /v1.*見積書/ })
      .click();
    await panel(page).getByRole("button", { name: "この版を削除" }).click();
    await expect(
      page.getByText(
        "『見積書』(v1)を削除します。アプリの記録から消えます。元の場所にあるファイルは消えません。",
      ),
    ).toBeVisible();
    await page.getByRole("button", { name: "削除", exact: true }).click();
    await expect(panel(page)).toContainText("v2(最新)");
    await expect(page.getByRole("row", { name: /見積書/ })).not.toContainText("旧版");

    // 最後の1版を削除: 行が消えて、横パネルが閉じる
    await panel(page).getByRole("button", { name: "この版を削除" }).click();
    await page.getByRole("button", { name: "削除", exact: true }).click();
    await expect(page.getByText("資料を削除しました").first()).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
    await expect(page.getByRole("row", { name: /見積書/ })).toHaveCount(0);
    await expect(page.getByText("まだ資料がありません")).toBeVisible();
    await expect(addButton(page)).toBeVisible();
  });
});

test.describe("役割と連携の状態による出し分け", () => {
  test("閲覧者には資料を追加と操作の欄を出さない", async ({ page }) => {
    await devLogin(page, "山田 太郎");
    await page.getByRole("row", { name: /社内テンプレート集/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "社内テンプレート集" })).toBeVisible();
    await expect(page.getByRole("button", { name: "+ 資料を追加" })).toHaveCount(0);
    await page.getByRole("row", { name: /提案テンプレート/ }).click();
    await expect(panel(page).getByRole("heading", { name: "提案テンプレート" })).toBeVisible();
    await expect(panel(page).getByRole("button", { name: "この版を削除" })).toHaveCount(0);
    await expect(panel(page).getByRole("button", { name: "これを元に作る" })).toHaveCount(0);
  });

  test("要再連携の田中は、資料を追加を「リンクで登録」で開き、作成系には案内を出して作成を押せなくする", async ({
    page,
  }) => {
    await devLogin(page, "田中 美咲");
    await page.getByRole("row", { name: /B社 市場調査/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "B社 市場調査" })).toBeVisible();
    await addButton(page).click();
    const dialog = addDialog(page);
    await expect(dialog.getByRole("tab", { name: "リンクで登録" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // 自動取得はせず、リンクでの登録はそのまま続けられる
    await dialog
      .getByRole("textbox", { name: "リンク" })
      .fill("https://docs.google.com/document/d/x1/edit");
    await expect(
      dialog.getByText(
        "ドライブ連携の有効期限が切れているため、資料名を取得できません。入力してください。",
      ),
    ).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "資料名" })).toBeEditable();
    await expect(dialog.getByRole("button", { name: "ドライブから選ぶ" })).toHaveCount(0);

    await dialog.getByRole("tab", { name: "新しく作る" }).click();
    await expect(dialog.getByText("ドライブ連携の有効期限が切れました")).toBeVisible();
    await dialog.getByRole("textbox", { name: "資料名" }).fill("作れない資料");
    await expect(dialog.getByRole("button", { name: "作成" })).toBeDisabled();
    await page.keyboard.press("Escape");

    // これを元に作る: 作成ダイアログも同じ
    await page.getByRole("row", { name: /提案書\(B社向け\)/ }).click();
    await panel(page).getByRole("button", { name: "これを元に作る" }).click();
    const copy = page.getByRole("dialog", { name: "これを元に作る" });
    await expect(copy.getByText("ドライブ連携の有効期限が切れました")).toBeVisible();
    await expect(copy.getByRole("button", { name: "作成" })).toBeDisabled();

    // 「もう一度連携する」で Google の許可画面へ移る(ここでは移り先だけ確かめる。田中の状態は変えない)
    await page.route("**/api/auth/google/reconnect**", (route) =>
      route.fulfill({ contentType: "text/html", body: "reconnect" }),
    );
    await copy.getByRole("button", { name: "もう一度連携する" }).click();
    await expect(page).toHaveURL(/\/api\/auth\/google\/reconnect\?returnTo=/);
  });
});

test.describe("モバイル", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("変更の操作を出さない", async ({ page }) => {
    await devLogin(page, "山田 太郎");
    await page.getByRole("row", { name: /A社 DX提案/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "A社 DX提案" })).toBeVisible();
    await expect(page.getByRole("button", { name: "+ 資料を追加" })).toHaveCount(0);
    await page.getByRole("row", { name: /提案書 v3/ }).click();
    await expect(page.getByRole("button", { name: "この版を削除" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "新しい版を作る" })).toHaveCount(0);
  });
});
