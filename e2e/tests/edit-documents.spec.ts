import { expect, type Page, test } from "@playwright/test";
import {
  addButton,
  addDialog,
  createDocument,
  panel,
  registerByLink,
  startInNewProject,
} from "./helpers";

// 残りのダイアログ「新しい版を登録」「登録内容を編集」(design-spec 6.5.5・6.5.6)。
// 各テストは自分の案件の中で操作する

const versionDialog = (page: Page) => page.getByRole("dialog", { name: "新しい版を登録" });
const editDialog = (page: Page) => page.getByRole("dialog", { name: "登録内容を編集" });

/** 参考資料の欄で名前を検索し、候補を1つ選ぶ */
async function addReference(dialog: ReturnType<typeof addDialog>, query: string, name: string) {
  await dialog.getByRole("searchbox", { name: "参考資料" }).fill(query);
  await dialog.getByRole("button", { name: new RegExp(name) }).click();
}

test.beforeEach(async ({ context }) => {
  await context.route("https://docs.google.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<title>editor</title>" }),
  );
});

test.describe("新しい版を登録", () => {
  test("最新版の名前を初期値に、次の版として登録する。変更メモは空で始まり、タグは引き継がない", async ({
    page,
  }) => {
    await startInNewProject(page, "E2E 登録: 版");
    await registerByLink(page, "https://example.com/files/report-v1.pdf", "報告書");
    await panel(page).getByRole("button", { name: "登録内容を編集" }).click();
    await editDialog(page).getByRole("textbox", { name: "タグ" }).fill("提出");
    await editDialog(page).getByRole("textbox", { name: "タグ" }).press("Enter");
    await editDialog(page).getByRole("button", { name: "保存" }).click();
    await expect(editDialog(page)).toHaveCount(0);

    await panel(page).getByRole("button", { name: "新しい版を登録" }).click();
    const dialog = versionDialog(page);
    await expect(dialog.getByRole("textbox", { name: "資料名" })).toHaveValue("報告書");
    await expect(dialog.getByRole("textbox", { name: "変更メモ" })).toHaveValue("");
    await expect(dialog.getByRole("textbox", { name: "タグ" })).toHaveCount(0);
    const submit = dialog.getByRole("button", { name: "登録", exact: true });
    await expect(submit).toBeDisabled();

    await dialog
      .getByRole("textbox", { name: "リンク" })
      .fill("https://example.com/files/report-v2.pdf");
    await dialog.getByRole("textbox", { name: "資料名" }).fill("報告書 v2");
    await dialog.getByRole("textbox", { name: "変更メモ" }).fill("図表を差し替え");
    await submit.click();

    await expect(versionDialog(page)).toHaveCount(0);
    await expect(page.getByText("新しい版を登録しました").first()).toBeVisible();
    await expect(panel(page).getByRole("heading", { name: "報告書 v2" })).toBeVisible();
    await expect(panel(page)).toContainText("v2(最新)");
    await expect(panel(page)).toContainText("図表を差し替え");
    // タグは引き継がないので、最新版には付かない。旧版のタグは版番号つきで表に残る
    const row = page.getByRole("row", { name: /報告書 v2/ });
    await expect(row).toContainText("旧版 1件");
    await expect(row).toContainText("提出 v1");
  });

  test("同じ案件に同じリンクがあれば登録せず、その資料を選べる。変更メモの上限を検証する", async ({
    page,
  }) => {
    await startInNewProject(page, "E2E 登録: 重複");
    await registerByLink(page, "https://example.com/a.pdf", "資料A");
    await registerByLink(page, "https://example.com/b.pdf", "資料B");

    await panel(page).getByRole("button", { name: "新しい版を登録" }).click();
    const dialog = versionDialog(page);
    await dialog.getByRole("textbox", { name: "リンク" }).fill("https://example.com/a.pdf");
    await dialog.getByRole("textbox", { name: "変更メモ" }).fill("あ".repeat(101));
    await expect(dialog.getByText("100文字以内で入力してください")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "登録", exact: true })).toBeDisabled();
    await dialog.getByRole("textbox", { name: "変更メモ" }).fill("");
    await dialog.getByRole("button", { name: "登録", exact: true }).click();
    await expect(
      dialog.getByText("この案件には同じリンクの資料がすでにあります: 資料A"),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "この資料を選ぶ" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(panel(page).getByRole("heading", { name: "資料A" })).toBeVisible();
  });

  test("参考資料は最新版から引き継ぎ、候補に同じ系列の版を出さない。削除された参考資料も引き継ぐ", async ({
    page,
  }) => {
    await startInNewProject(page, "E2E 登録: 参考資料");
    await registerByLink(page, "https://example.com/src.pdf", "参考元");
    await addButton(page).click();
    const add = addDialog(page);
    await add.getByRole("tab", { name: "リンクで登録" }).click();
    await add.getByRole("textbox", { name: "リンク" }).fill("https://example.com/main.pdf");
    await add.getByRole("textbox", { name: "資料名" }).fill("本体");
    await addReference(add, "参考元", "参考元");
    await add.getByRole("button", { name: "追加" }).click();
    await expect(panel(page).getByRole("heading", { name: "本体" })).toBeVisible();

    // 参考元を削除すると、本体の参考資料は「削除された資料」になる
    await page.getByRole("row", { name: /参考元/ }).click();
    await panel(page).getByRole("button", { name: "この版を削除" }).click();
    await page.getByRole("button", { name: "削除", exact: true }).click();
    await page.getByRole("row", { name: /本体/ }).click();
    await expect(panel(page)).toContainText("削除された資料");

    await panel(page).getByRole("button", { name: "新しい版を登録" }).click();
    const dialog = versionDialog(page);
    await expect(dialog.getByText("削除された資料")).toBeVisible();
    // 同じ系列の版は候補に出ない
    await dialog.getByRole("searchbox", { name: "参考資料" }).fill("本体");
    await expect(dialog.getByText("一致する資料がありません")).toBeVisible();
    await dialog.getByRole("textbox", { name: "リンク" }).fill("https://example.com/main-v2.pdf");
    await dialog.getByRole("textbox", { name: "資料名" }).fill("本体 v2");
    await dialog.getByRole("button", { name: "登録", exact: true }).click();
    await expect(panel(page).getByRole("heading", { name: "本体 v2" })).toBeVisible();
    await expect(panel(page)).toContainText("削除された資料");

    // 参考資料のチップを外して保存すると、見えない参考資料も外れる
    await panel(page).getByRole("button", { name: "登録内容を編集" }).click();
    const edit = editDialog(page);
    await edit.getByRole("button", { name: "削除された資料 を外す" }).click();
    await edit.getByRole("button", { name: "保存" }).click();
    await expect(edit).toHaveCount(0);
    await expect(panel(page).getByText("削除された資料")).toHaveCount(0);
  });

  test("ドライブには作れたが登録に失敗したら、「このリンクで登録」で入力済みの内容を入れて開く", async ({
    page,
  }) => {
    await startInNewProject(page, "E2E 登録: 作成後の失敗");
    await createDocument(page, "見積書", "google_slides");
    const url = "https://docs.google.com/presentation/d/created-but-lost-v2/edit";
    await page.route("**/api/series/*/versions/copy", (route) =>
      route.fulfill({
        status: 500,
        json: {
          error: {
            code: "DRIVE_CREATED_NOT_REGISTERED",
            message: "x",
            details: {
              file: { fileId: "created-but-lost-v2", url },
              cause: "internal",
              causeCode: "INTERNAL",
            },
          },
        },
      }),
    );
    await panel(page).getByRole("button", { name: "新しい版を作る" }).click();
    const copy = page.getByRole("dialog", { name: "新しい版を作る" });
    await copy.getByRole("textbox", { name: "資料名" }).fill("見積書 v2");
    await copy.getByRole("textbox", { name: "変更メモ" }).fill("価格を更新");
    await copy.getByRole("button", { name: "作成" }).click();
    await expect(
      copy.getByText("ドライブに資料は作成されましたが、登録できませんでした。"),
    ).toBeVisible();
    await copy.getByRole("button", { name: "このリンクで登録" }).click();

    const dialog = versionDialog(page);
    await expect(dialog.getByRole("textbox", { name: "リンク" })).toHaveValue(url);
    await expect(dialog.getByRole("textbox", { name: "資料名" })).toHaveValue("見積書 v2");
    await expect(dialog.getByRole("textbox", { name: "変更メモ" })).toHaveValue("価格を更新");
    await page.unroute("**/api/series/*/versions/copy");
    await dialog.getByRole("button", { name: "登録", exact: true }).click();
    await expect(panel(page)).toContainText("v2(最新)");
    await expect(panel(page)).toContainText("価格を更新");
  });
});

test.describe("登録内容を編集", () => {
  test("タグと変更メモを直すと、表のバッジと横パネルに反映される。確定していない入力は保存のときに確定する", async ({
    page,
  }) => {
    await startInNewProject(page, "E2E 編集: タグ");
    await registerByLink(page, "https://example.com/files/plan.pdf", "計画書");
    await panel(page).getByRole("button", { name: "登録内容を編集" }).click();
    const dialog = editDialog(page);
    const tag = dialog.getByRole("textbox", { name: "タグ" });

    await tag.fill("Final");
    await tag.press("Enter");
    // 大文字・小文字、全角・半角の英数字は区別しない: 追加せず、既存のチップを光らせる
    await tag.fill("ＦＩＮＡＬ");
    await tag.press("Enter");
    await expect(dialog.getByRole("button", { name: /^タグ .* を外す$/ })).toHaveCount(1);
    await tag.fill("確定");
    await tag.press("Enter");
    await tag.fill("a");
    await tag.press("Enter");
    await tag.fill("b");
    await tag.press("Enter");
    await tag.fill("c");
    await tag.press("Enter");
    // 5件で入力欄が無効になる
    await expect(tag).toBeDisabled();
    await expect(dialog.getByText("タグは5件まで付けられます")).toBeVisible();
    await dialog.getByRole("button", { name: "タグ c を外す" }).click();
    await dialog.getByRole("button", { name: "タグ b を外す" }).click();
    await expect(tag).toBeEnabled();

    // Enter を押さないまま保存しても、確定してから保存する
    await tag.fill("ドラフト");
    await dialog.getByRole("textbox", { name: "変更メモ" }).fill("初稿を整理");
    await dialog.getByRole("button", { name: "保存" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("登録内容を保存しました").first()).toBeVisible();

    const row = page.getByRole("row", { name: /計画書/ });
    await expect(row).toContainText("Final");
    // 横パネルが開いている間、表のタグは1つと「+n」(Final・確定・a・ドラフト のうち残り3つ)
    await expect(row).toContainText("+3");
    await expect(panel(page)).toContainText("初稿を整理");
    for (const label of ["Final", "確定", "a", "ドラフト"]) {
      await expect(panel(page).getByText(label, { exact: true }).first()).toBeVisible();
    }
  });

  test("タグの候補はこの案件のタグから出る。タグを外して保存すると消える", async ({ page }) => {
    await startInNewProject(page, "E2E 編集: 候補");
    await registerByLink(page, "https://example.com/c1.pdf", "資料1");
    await registerByLink(page, "https://example.com/c2.pdf", "資料2");
    await panel(page).getByRole("button", { name: "登録内容を編集" }).click();
    const first = editDialog(page);
    await first.getByRole("textbox", { name: "タグ" }).fill("提出");
    await first.getByRole("textbox", { name: "タグ" }).press("Enter");
    await first.getByRole("button", { name: "保存" }).click();
    await expect(first).toHaveCount(0);

    await page.getByRole("row", { name: /資料1/ }).click();
    await panel(page).getByRole("button", { name: "登録内容を編集" }).click();
    const second = editDialog(page);
    await second.getByRole("textbox", { name: "タグ" }).fill("提");
    await second.getByRole("button", { name: "提出", exact: true }).first().click();
    await expect(second.getByRole("button", { name: "タグ 提出 を外す" })).toBeVisible();
    await second.getByRole("button", { name: "タグ 提出 を外す" }).click();
    await second.getByRole("button", { name: "保存" }).click();
    await expect(second).toHaveCount(0);
    await expect(page.getByRole("row", { name: /資料1/ })).not.toContainText("提出");
  });

  test("Google から名前を取得済みの版は、名前と更新日時が読み取り専用。リンクを変えると手で直せる", async ({
    page,
  }) => {
    await startInNewProject(page, "E2E 編集: 取得済み");
    await createDocument(page, "取得済みの資料");
    await panel(page).getByRole("button", { name: "登録内容を編集" }).click();
    const dialog = editDialog(page);
    const name = dialog.getByRole("textbox", { name: "資料名" });
    await expect(name).toHaveValue("取得済みの資料");
    await expect(name).toHaveAttribute("readonly", "");
    await expect(
      dialog.getByText("ドライブの名前を使います。名前はドライブで変更してください。"),
    ).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "変更メモ" })).toBeEnabled();

    await dialog.getByRole("textbox", { name: "リンク" }).fill("https://example.com/moved.pdf");
    await expect(name).not.toHaveAttribute("readonly", "");
    await expect(
      dialog.getByText("ドライブの名前を使います。名前はドライブで変更してください。"),
    ).toHaveCount(0);
    await name.fill("手で付けた名前");
    await dialog.getByRole("button", { name: "保存" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(panel(page).getByRole("heading", { name: "手で付けた名前" })).toBeVisible();
    await expect(panel(page).getByRole("link", { name: "開く ↗" })).toHaveAttribute(
      "href",
      "https://example.com/moved.pdf",
    );

    // 取得した記録を消したので、次は名前を編集できる
    await panel(page).getByRole("button", { name: "登録内容を編集" }).click();
    await expect(editDialog(page).getByRole("textbox", { name: "資料名" })).not.toHaveAttribute(
      "readonly",
      "",
    );
  });

  test("リンクを同じ案件の別の資料と同じにすると保存せず、理由を出す。削除された版を保存しようとすると閉じる", async ({
    page,
  }) => {
    await startInNewProject(page, "E2E 編集: 失敗");
    await registerByLink(page, "https://example.com/e1.pdf", "資料1");
    await registerByLink(page, "https://example.com/e2.pdf", "資料2");
    await panel(page).getByRole("button", { name: "登録内容を編集" }).click();
    const dialog = editDialog(page);
    await dialog.getByRole("textbox", { name: "リンク" }).fill("https://example.com/e1.pdf");
    await dialog.getByRole("button", { name: "保存" }).click();
    await expect(
      dialog.getByText("この案件には同じリンクの資料がすでにあります: 資料1"),
    ).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "リンク" })).toHaveValue(
      "https://example.com/e1.pdf",
    );

    // 保存の途中で版が削除されていた: ダイアログを閉じ、通知する
    await page.route("**/api/documents/*", (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill({
            status: 404,
            json: {
              error: { code: "DOCUMENT_NOT_FOUND", message: "x", details: { seriesExists: false } },
            },
          })
        : route.continue(),
    );
    await dialog.getByRole("textbox", { name: "リンク" }).fill("https://example.com/e3.pdf");
    await dialog.getByRole("button", { name: "保存" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("この資料は削除されたか、見つかりません").first()).toBeVisible();
  });
});
