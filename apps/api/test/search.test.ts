import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as schema from "../src/db/schema";
import { createTestContext, type Json, USERS } from "./helpers";

const ctx = createTestContext();
beforeEach(() => ctx.seed());
afterAll(() => ctx.close());

async function get(email: string, path: string) {
  return ctx.call("GET", path, { cookie: await ctx.login(email) });
}

describe("GET /api/search", () => {
  test("「提案書」は design-spec 6.4 の画面例の4件を、更新の新しい順に返す", async () => {
    const reply = await get(USERS.yamada, `/api/search?q=${encodeURIComponent("提案書")}`);
    expect(reply.status).toBe(200);
    expect(reply.json.truncated).toBe(false);
    expect(reply.json.results.map((r: Json) => [r.name, r.projectName, r.isLatest])).toEqual([
      ["提案書 v3", "A社 DX提案", true],
      ["提案書 v2", "A社 DX提案", false],
      ["提案書(B社向け)", "B社 市場調査", true],
      ["提案書 初稿", "A社 DX提案", false],
    ]);
    expect(reply.json.results[0]).toMatchObject({
      kind: "google_slides",
      url: "https://docs.google.com/presentation/d/seed-proposal-v3/edit",
      modifiedAt: "2026-09-28T01:12:00.000Z",
    });
  });

  test("大文字・小文字、全角・半角の英数字を区別しない。前後の空白は無視する", async () => {
    await ctx.db
      .update(schema.documents)
      .set({ name: "Ｍｉｎｕｔｅｓ ＡＢＣ", nameKey: "minutes abc" });
    const reply = await get(
      USERS.yamada,
      `/api/search?q=${encodeURIComponent("  mINUTES ａｂｃ ")}`,
    );
    expect(reply.json.results.length).toBeGreaterThan(0);
  });

  test("LIKE のワイルドカードは文字として検索する", async () => {
    for (const q of ["%", "_", "\\"]) {
      const reply = await get(USERS.yamada, `/api/search?q=${encodeURIComponent(q)}`);
      expect(reply.status).toBe(200);
      expect(reply.json.results).toEqual([]);
    }
  });

  test("参加していない案件・削除された案件・削除された版は含めない", async () => {
    const names = async (email: string, q: string) =>
      (await get(email, `/api/search?q=${encodeURIComponent(q)}`)).json.results.map(
        (r: Json) => r.name,
      );
    expect(await names(USERS.yamada, "研修")).toEqual([]);
    expect(await names(USERS.tanaka, "研修")).toEqual(["研修カリキュラム"]);
    expect(await names(USERS.yamada, "現状分析")).toEqual([]);
    expect(await names(USERS.yamada, "見積書")).toEqual(["見積書", "見積書 v1"]);
  });

  test("50件を超えると50件に切って truncated: true", async () => {
    const project = await ctx.projectId("A社 DX提案");
    const seriesId = await ctx.seriesId("調査レポート");
    const [user] = await ctx.db.select().from(schema.users);
    await ctx.db.insert(schema.documents).values(
      Array.from({ length: 51 }, (_, i) => ({
        seriesId,
        projectId: project,
        versionNo: 100 + i,
        name: `大量 ${i}`,
        nameKey: `大量 ${i}`,
        url: `https://example.com/bulk/${i}`,
        linkKey: `u:https://example.com/bulk/${i}`,
        kind: "other" as const,
        createdVia: "link" as const,
        registeredBy: (user as { id: string }).id,
      })),
    );
    const reply = await get(USERS.yamada, `/api/search?q=${encodeURIComponent("大量")}`);
    expect(reply.json.results).toHaveLength(50);
    expect(reply.json.truncated).toBe(true);
  });

  test("検索語が空・101文字は 422(検索語の欄)", async () => {
    for (const [q, error] of [
      [" ", "required"],
      ["あ".repeat(101), "too_long"],
    ] as const) {
      const reply = await get(USERS.yamada, `/api/search?q=${encodeURIComponent(q)}`);
      expect(reply.status).toBe(422);
      expect(reply.json.error.details.fields).toEqual({ q: error });
    }
    expect((await get(USERS.yamada, "/api/search")).status).toBe(422);
  });
});

describe("GET /api/reference-candidates", () => {
  test("参加している案件の系列の最新版だけを、案件名つきで返す(旧版・削除済み・不参加は含めない)", async () => {
    const reply = await get(USERS.yamada, "/api/reference-candidates");
    const names = reply.json.candidates.map((c: Json) => c.name).sort();
    expect(names).toEqual(
      [
        "提案書 v3",
        "調査レポート",
        "見積書",
        "議事録 9/15",
        "業界ニュースまとめ",
        "提案書(B社向け)",
        "競合比較",
        "提案テンプレート",
      ].sort(),
    );
    expect(reply.json.candidates.find((c: Json) => c.name === "競合比較")).toMatchObject({
      projectName: "B社 市場調査",
      kind: "google_sheets",
    });
  });

  test("語で絞り込み、excludeSeriesId の系列を除く", async () => {
    const exclude = await ctx.seriesId("提案書 v3");
    const reply = await get(
      USERS.yamada,
      `/api/reference-candidates?q=${encodeURIComponent("提案")}&excludeSeriesId=${exclude}`,
    );
    expect(reply.json.candidates.map((c: Json) => c.name).sort()).toEqual(
      ["提案書(B社向け)", "提案テンプレート"].sort(),
    );
  });

  test("excludeSeriesId が UUID でなければ 422、20件を超えると20件に切る", async () => {
    const bad = await get(USERS.yamada, "/api/reference-candidates?excludeSeriesId=x");
    expect(bad.status).toBe(422);
    expect(bad.json.error.details.fields).toEqual({ excludeSeriesId: "invalid_format" });

    const project = await ctx.projectId("A社 DX提案");
    const [user] = await ctx.db.select().from(schema.users);
    for (let i = 0; i < 25; i++) {
      const [series] = await ctx.db
        .insert(schema.documentSeries)
        .values({ projectId: project, nextVersionNo: 2 })
        .returning();
      await ctx.db.insert(schema.documents).values({
        seriesId: (series as { id: string }).id,
        projectId: project,
        versionNo: 1,
        name: `候補 ${i}`,
        nameKey: `候補 ${i}`,
        url: `https://example.com/c/${i}`,
        linkKey: `u:https://example.com/c/${i}`,
        kind: "other",
        createdVia: "link",
        registeredBy: (user as { id: string }).id,
      });
    }
    const many = await get(
      USERS.yamada,
      `/api/reference-candidates?q=${encodeURIComponent("候補")}`,
    );
    expect(many.json.candidates).toHaveLength(20);
  });
});

describe("GET /api/projects/:projectId/tags", () => {
  test("案件の削除されていない版に付いたタグを返す(削除済みの版のタグは含めない)", async () => {
    const project = await ctx.projectId("A社 DX提案");
    const reply = await get(USERS.sato, `/api/projects/${project}/tags`);
    expect(reply.status).toBe(200);
    expect([...reply.json.tags].sort()).toEqual(["ドラフト", "確定", "確認済", "提出"].sort());
  });

  test("語で絞り込む。表記が違う同じタグは、最も新しく付けた行の表記を1件だけ返す", async () => {
    const project = await ctx.projectId("A社 DX提案");
    const sato = await ctx.login(USERS.sato);
    const v2 = await ctx.documentId("提案書 v2");
    await ctx.call("PATCH", `/api/documents/${v2}`, { cookie: sato, body: { tags: ["FINAL"] } });
    const v3 = await ctx.documentId("提案書 v3");
    await ctx.call("PATCH", `/api/documents/${v3}`, { cookie: sato, body: { tags: ["final"] } });
    const reply = await get(
      USERS.sato,
      `/api/projects/${project}/tags?q=${encodeURIComponent("ＦＩＮ")}`,
    );
    expect(reply.json.tags).toEqual(["final"]);
  });

  test("語が101文字なら 422。不参加は 404", async () => {
    const project = await ctx.projectId("A社 DX提案");
    const long = await get(USERS.sato, `/api/projects/${project}/tags?q=${"あ".repeat(101)}`);
    expect(long.status).toBe(422);
    expect((await get(USERS.tanaka, `/api/projects/${project}/tags`)).status).toBe(404);
  });
});
