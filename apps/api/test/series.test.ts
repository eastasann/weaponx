import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createTestContext, type Json, USERS } from "./helpers";

const ctx = createTestContext();
beforeEach(() => ctx.seed());
afterAll(() => ctx.close());

async function seriesOf(email: string, project: string): Promise<Json[]> {
  const reply = await ctx.call("GET", `/api/projects/${await ctx.projectId(project)}/series`, {
    cookie: await ctx.login(email),
  });
  expect(reply.status).toBe(200);
  return reply.json.series;
}

describe("GET /api/projects/:projectId/series", () => {
  test("A社 DX提案は design-spec 6.1 の画面例の5行を、最新版の更新の新しい順に返す", async () => {
    const rows = await seriesOf(USERS.yamada, "A社 DX提案");
    expect(rows.map((r) => r.latest.name)).toEqual([
      "提案書 v3",
      "調査レポート",
      "見積書",
      "議事録 9/15",
      "業界ニュースまとめ",
    ]);
    const proposal = rows[0] as Json;
    expect(proposal.tags).toEqual([
      { label: "確認済", versionNo: null },
      { label: "提出", versionNo: 2 },
      { label: "ドラフト", versionNo: 1 },
    ]);
    expect(proposal.olderCount).toBe(2);
    expect(proposal.searchNames).toHaveLength(3);
    expect(proposal.latest).toMatchObject({
      versionNo: 3,
      isLatest: true,
      kind: "google_slides",
      nameLocked: true,
      changeNote: "A社の指摘を反映",
      tags: ["確認済"],
      registeredBy: { displayName: "山田 太郎", email: USERS.yamada },
    });
  });

  test("削除された版は、旧版の件数・タグ・検索名に含めない", async () => {
    const estimate = (await seriesOf(USERS.yamada, "A社 DX提案")).find(
      (r) => r.latest.name === "見積書",
    ) as Json;
    expect(estimate.olderCount).toBe(1);
    expect(estimate.tags).toEqual([{ label: "確定", versionNo: null }]);
    expect(estimate.searchNames.sort()).toEqual(["見積書", "見積書 v1"]);
  });

  test("更新日時が無い版は登録日時を、更新日時を取得済みでない版は sourceModifiedAt を null で返す", async () => {
    const minutes = (await seriesOf(USERS.yamada, "A社 DX提案")).find(
      (r) => r.latest.name === "議事録 9/15",
    ) as Json;
    expect(minutes.latest.sourceModifiedAt).toBeNull();
    expect(minutes.latest.modifiedAt).toBe(minutes.latest.createdAt);
    expect(minutes.latest.nameLocked).toBe(false);
  });

  test("停止された人が登録した資料も、登録した人の名前を返す", async () => {
    const [row] = await seriesOf(USERS.tanaka, "D社 研修企画");
    expect(row?.latest.registeredBy.displayName).toBe("鈴木 一郎");
  });
});

describe("GET /api/series/:seriesId", () => {
  async function detail(email: string, name: string, query = ""): Promise<Json> {
    const id = await ctx.seriesId(name);
    const reply = await ctx.call("GET", `/api/series/${id}${query}`, {
      cookie: await ctx.login(email),
    });
    expect(reply.status).toBe(200);
    return reply.json;
  }

  test("提案書: 版3件(新しい順)・参考資料2件・参考にした資料2件", async () => {
    const json = await detail(USERS.yamada, "提案書 v3");
    expect(json.versions.map((v: Json) => v.versionNo)).toEqual([3, 2, 1]);
    expect(json.selectedDocumentId).toBe(json.versions[0].id);
    expect(json.versions[1].tags).toEqual(["提出"]);
    expect(json.references).toEqual([
      expect.objectContaining({
        visibility: "visible",
        name: "調査レポート",
        projectName: null,
        versionNo: 1,
        isLatest: true,
      }),
      expect.objectContaining({
        visibility: "visible",
        name: "提案テンプレート",
        projectName: "社内テンプレート集",
      }),
    ]);
    expect(json.referencedBy).toEqual([
      expect.objectContaining({
        visibility: "visible",
        name: "見積書",
        projectName: null,
        versionNo: 3,
        isLatest: true,
        // 見積書 v1 が提案書 v1 を参考にしている(v2 は削除済みなので数えない)
        referencedVersionNo: 1,
      }),
      expect.objectContaining({
        visibility: "visible",
        name: "提案書(B社向け)",
        projectName: "B社 市場調査",
        referencedVersionNo: 2,
      }),
    ]);
  });

  test("documentId で版を選ぶと、その版の参考資料を返す。見積書 v1 の参考資料は提案書 v1", async () => {
    const series = await ctx.seriesId("見積書 v1");
    const v1 = await ctx.documentId("見積書 v1");
    const reply = await ctx.call("GET", `/api/series/${series}?documentId=${v1}`, {
      cookie: await ctx.login(USERS.yamada),
    });
    expect(reply.json.selectedDocumentId).toBe(v1);
    expect(reply.json.references).toEqual([
      expect.objectContaining({ name: "提案書 初稿", versionNo: 1, isLatest: false }),
    ]);
  });

  test("業界ニュースまとめの参考資料は、山田では deleted、佐藤では no_access(名前も ID も返さない)", async () => {
    const yamada = await detail(USERS.yamada, "業界ニュースまとめ");
    expect(yamada.references).toEqual([{ visibility: "deleted", referenceId: expect.any(String) }]);
    const sato = await detail(USERS.sato, "業界ニュースまとめ");
    expect(sato.references).toEqual([{ visibility: "no_access", referenceId: expect.any(String) }]);
    expect(JSON.stringify(sato)).not.toContain("現状分析");
    expect(JSON.stringify(yamada)).not.toContain("現状分析");
  });

  test("競合比較の参考資料(D社)は、参加していない山田・佐藤に no_access", async () => {
    const json = await detail(USERS.yamada, "競合比較");
    expect(json.references).toEqual([{ visibility: "no_access", referenceId: expect.any(String) }]);
  });

  test("参考にした資料は、見られない案件の資料を no_access で返す(ID は返さない)", async () => {
    // 提案テンプレートを参考にしている提案書(A社)を、A社に参加していない人が見る場面を作る
    const json = await detail(USERS.sato, "提案テンプレート");
    expect(json.referencedBy).toEqual([
      expect.objectContaining({ visibility: "visible", name: "提案書 v3" }),
    ]);
    const outsiderView = await ctx.call(
      "GET",
      `/api/series/${await ctx.seriesId("提案テンプレート")}`,
      {
        cookie: await ctx.login(USERS.tanaka),
      },
    );
    // 田中は A社 に参加していない
    expect(outsiderView.json.referencedBy).toEqual([{ visibility: "no_access" }]);
  });

  test("削除済み・別の系列の版を documentId に指定すると 404 DOCUMENT_NOT_FOUND(seriesExists: true)", async () => {
    const series = await ctx.seriesId("見積書 v1");
    const cookie = await ctx.login(USERS.yamada);
    for (const documentId of [
      await ctx.documentId("見積書 v2"),
      await ctx.documentId("提案書 v3"),
    ]) {
      const reply = await ctx.call("GET", `/api/series/${series}?documentId=${documentId}`, {
        cookie,
      });
      expect(reply.status).toBe(404);
      expect(reply.json.error).toMatchObject({
        code: "DOCUMENT_NOT_FOUND",
        details: { seriesExists: true },
      });
    }
  });

  test("系列が無い・形式が違う ID は 404 DOCUMENT_NOT_FOUND(seriesExists: false)", async () => {
    const cookie = await ctx.login(USERS.yamada);
    for (const id of ["not-a-uuid", crypto.randomUUID()]) {
      const reply = await ctx.call("GET", `/api/series/${id}`, { cookie });
      expect(reply.status).toBe(404);
      expect(reply.json.error).toMatchObject({
        code: "DOCUMENT_NOT_FOUND",
        details: { seriesExists: false },
      });
    }
  });

  test("案件に参加していない人は 404 PROJECT_NOT_FOUND。削除済みの案件の系列も同じ", async () => {
    const a = await ctx.call("GET", `/api/series/${await ctx.seriesId("提案書 v3")}`, {
      cookie: await ctx.login(USERS.tanaka),
    });
    expect(a.status).toBe(404);
    expect(a.json.error.code).toBe("PROJECT_NOT_FOUND");
    const deleted = await ctx.call("GET", `/api/series/${await ctx.seriesId("現状分析")}`, {
      cookie: await ctx.login(USERS.yamada),
    });
    expect(deleted.status).toBe(404);
    expect(deleted.json.error.code).toBe("PROJECT_NOT_FOUND");
  });
});
