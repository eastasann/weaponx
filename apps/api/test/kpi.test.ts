import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createTestContext, USERS } from "./helpers";

const ctx = createTestContext();
beforeEach(() => ctx.seed());
afterAll(() => ctx.close());

/** 運用 Runbook 6章の「KPI の測り方」の SQL を、文書のまま取り出す(文書と実体の食い違いを防ぐ) */
const runbook = readFileSync(
  new URL("../../../docs/05_operation-runbook.md", import.meta.url),
  "utf8",
);
const kpiQueries = (runbook.split("### KPI の測り方")[1]?.match(/```sql\n([\s\S]*?)```/)?.[1] ?? "")
  .split(";")
  .map((s) => s.trim())
  .filter((s) => s.replace(/^--.*$/gm, "").trim() !== "");
// 取り出しに失敗したまま空のクエリで流すと結果が null になり、「割合は null」の確認が素通りするので、ここで止める
if (kpiQueries.length !== 2) {
  throw new Error(`05 運用 Runbook 6章の KPI の SQL は2本のはずが ${kpiQueries.length} 本だった`);
}
const [appCreatedSql, changeNoteSql] = kpiQueries as [string, string];

async function pct(query: string): Promise<string | null> {
  const rows = await ctx.sql.unsafe(query);
  return (Object.values(rows[0] ?? {})[0] as string | null) ?? null;
}

describe("KPI の SQL(05 運用 Runbook 6章)", () => {
  test("文書から SQL を2本取り出せる", () => {
    expect(appCreatedSql).toContain("app_created_pct");
    expect(changeNoteSql).toContain("change_note_pct");
  });

  test("直近28日に記録された版が無ければ、割合は null(0 除算にならない)", async () => {
    await ctx.sql`update documents set created_at = now() - interval '60 days'`;
    expect(await pct(appCreatedSql)).toBeNull();
    expect(await pct(changeNoteSql)).toBeNull();
  });

  test("デモデータの版を直近に記録したものとすると、割合が意図どおりに出る", async () => {
    await ctx.sql`update documents set created_at = now()`;
    const [counts] = await ctx.sql`
      select
        count(*)::int as total,
        (count(*) filter (where created_via in ('created', 'copied')))::int as app_created,
        (count(*) filter (where version_no >= 2))::int as later,
        (count(*) filter (where version_no >= 2 and change_note is not null))::int as noted
      from documents`;
    const c = counts as { total: number; app_created: number; later: number; noted: number };
    expect(c.app_created).toBeGreaterThan(0);
    expect(c.noted).toBeGreaterThan(0);
    expect(c.noted).toBeLessThan(c.later);
    const round1 = (n: number, d: number) => (Math.round((1000 * n) / d) / 10).toFixed(1);
    expect(await pct(appCreatedSql)).toBe(round1(c.app_created, c.total));
    expect(await pct(changeNoteSql)).toBe(round1(c.noted, c.later));
  });

  test("アプリで作った版とリンクで登録した版が、それぞれの分子・分母に入る", async () => {
    await ctx.sql`update documents set created_at = now() - interval '60 days'`;
    const cookie = await ctx.login(USERS.yamada);
    const series = await ctx.seriesId("提案書 v3");
    const source = await ctx.documentId("提案書 v3");
    const copy = (body: object) =>
      ctx.call("POST", `/api/series/${series}/versions/copy`, {
        cookie,
        body: { sourceDocumentId: source, ...body },
      });
    expect((await copy({ name: "v4", changeNote: "価格を更新" })).status).toBe(201);
    expect((await copy({ name: "v5" })).status).toBe(201);
    const linked = await ctx.call("POST", `/api/series/${series}/versions`, {
      cookie,
      body: { url: "https://example.com/kpi-v6.pdf", name: "v6", kind: "pdf" },
    });
    expect(linked.status).toBe(201);
    // 削除された版も記録した事実は変わらないので、分母に残る
    const removed = await ctx.call("DELETE", `/api/documents/${linked.json.document.id}`, {
      cookie,
    });
    expect(removed.status).toBe(200);
    const [row] =
      await ctx.sql`select deleted_at from documents where id = ${linked.json.document.id}`;
    expect(row?.deleted_at).not.toBeNull();
    expect(await pct(appCreatedSql)).toBe("66.7");
    expect(await pct(changeNoteSql)).toBe("33.3");
  });
});
