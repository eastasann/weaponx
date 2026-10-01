import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { createTestContext, USERS } from "./helpers";

const ctx = createTestContext();
beforeEach(() => ctx.seed());
afterAll(() => ctx.close());

describe("GET /api/projects", () => {
  test("参加している削除されていない案件を、最終更新の新しい順に返す", async () => {
    const reply = await ctx.call("GET", "/api/projects", { cookie: await ctx.login(USERS.yamada) });
    expect(reply.status).toBe(200);
    const projects = reply.json.projects as {
      name: string;
      myRole: string;
      documentCount: number;
      lastActivityAt: string;
    }[];
    expect(projects.map((p) => p.name).sort()).toEqual(
      ["A社 DX提案", "B社 市場調査", "社内テンプレート集"].sort(),
    );
    expect(Object.fromEntries(projects.map((p) => [p.name, p.myRole]))).toEqual({
      "A社 DX提案": "owner",
      "B社 市場調査": "editor",
      社内テンプレート集: "viewer",
    });
    const times = projects.map((p) => Date.parse(p.lastActivityAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  test("資料数は、削除されていない版を持つ系列の数(削除済みの版だけの系列は数えない)", async () => {
    const reply = await ctx.call("GET", "/api/projects", { cookie: await ctx.login(USERS.yamada) });
    const a = reply.json.projects.find((p: { name: string }) => p.name === "A社 DX提案");
    // 調査レポート・提案書・見積書・議事録・業界ニュースまとめ
    expect(a.documentCount).toBe(5);
  });

  test("minRole=editor は編集者以上の案件だけ", async () => {
    const reply = await ctx.call("GET", "/api/projects?minRole=editor", {
      cookie: await ctx.login(USERS.yamada),
    });
    expect(reply.json.projects.map((p: { name: string }) => p.name).sort()).toEqual([
      "A社 DX提案",
      "B社 市場調査",
    ]);
    const owner = await ctx.call("GET", "/api/projects?minRole=owner", {
      cookie: await ctx.login(USERS.yamada),
    });
    expect(owner.json.projects.map((p: { name: string }) => p.name)).toEqual(["A社 DX提案"]);
  });

  test("minRole が不正なら 422", async () => {
    const reply = await ctx.call("GET", "/api/projects?minRole=admin", {
      cookie: await ctx.login(USERS.yamada),
    });
    expect(reply.status).toBe(422);
    expect(reply.json.error.details.fields).toEqual({ minRole: "invalid_format" });
  });
});

describe("POST /api/projects", () => {
  test("201 で作り、作成者が最初のオーナーになる。前後の空白は取り除く", async () => {
    const cookie = await ctx.login(USERS.sato);
    const reply = await ctx.call("POST", "/api/projects", {
      cookie,
      body: { name: "  新規案件 " },
    });
    expect(reply.status).toBe(201);
    expect(reply.json.project).toMatchObject({
      name: "新規案件",
      myRole: "owner",
      documentCount: 0,
    });
    const members = await ctx.db
      .select()
      .from(schema.projectMembers)
      .where(eq(schema.projectMembers.projectId, reply.json.project.id));
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ role: "owner", addedBy: null });
    expect((await ctx.call("GET", "/api/projects", { cookie })).json.projects[0].name).toBe(
      "新規案件",
    );
  });

  test("空・長すぎる・改行を含む案件名は 422 VALIDATION_FAILED", async () => {
    const cookie = await ctx.login(USERS.sato);
    const cases: [string, string][] = [
      ["   ", "required"],
      ["あ".repeat(101), "too_long"],
      ["a\nb", "invalid_format"],
    ];
    for (const [name, error] of cases) {
      const reply = await ctx.call("POST", "/api/projects", { cookie, body: { name } });
      expect(reply.status).toBe(422);
      expect(reply.json.error.code).toBe("VALIDATION_FAILED");
      expect(reply.json.error.details.fields).toEqual({ name: error });
    }
    expect(
      (await ctx.call("POST", "/api/projects", { cookie, body: { name: "あ".repeat(100) } }))
        .status,
    ).toBe(201);
  });
});

describe("案件の取得・変更・削除", () => {
  test("GET は役割・メンバー数・資料数・最終更新を返す", async () => {
    const id = await ctx.projectId("A社 DX提案");
    const reply = await ctx.call("GET", `/api/projects/${id}`, {
      cookie: await ctx.login(USERS.sato),
    });
    expect(reply.status).toBe(200);
    expect(reply.json.project).toMatchObject({
      id,
      name: "A社 DX提案",
      myRole: "editor",
      memberCount: 3,
      documentCount: 5,
    });
  });

  test("PATCH はオーナーが案件名を変え、last_activity_at を進める", async () => {
    const id = await ctx.projectId("A社 DX提案");
    const [before] = await ctx.db.select().from(schema.projects).where(eq(schema.projects.id, id));
    const reply = await ctx.call("PATCH", `/api/projects/${id}`, {
      cookie: await ctx.login(USERS.yamada),
      body: { name: " A社 DX提案(改)" },
    });
    expect(reply.status).toBe(200);
    expect(reply.json.project.name).toBe("A社 DX提案(改)");
    const [after] = await ctx.db.select().from(schema.projects).where(eq(schema.projects.id, id));
    expect(after?.lastActivityAt.getTime()).toBeGreaterThan(before?.lastActivityAt.getTime() ?? 0);
  });

  test("PATCH の検証エラーでは案件名を変えない", async () => {
    const id = await ctx.projectId("A社 DX提案");
    const reply = await ctx.call("PATCH", `/api/projects/${id}`, {
      cookie: await ctx.login(USERS.yamada),
      body: { name: "" },
    });
    expect(reply.status).toBe(422);
    const [row] = await ctx.db.select().from(schema.projects).where(eq(schema.projects.id, id));
    expect(row?.name).toBe("A社 DX提案");
  });

  test("DELETE は 204 で deleted_at・deleted_by を入れ、以降は 404 PROJECT_NOT_FOUND。メンバーの行は残る", async () => {
    const id = await ctx.projectId("A社 DX提案");
    const cookie = await ctx.login(USERS.yamada);
    expect((await ctx.call("DELETE", `/api/projects/${id}`, { cookie })).status).toBe(204);
    const [row] = await ctx.db.select().from(schema.projects).where(eq(schema.projects.id, id));
    expect(row?.deletedAt).toBeTruthy();
    expect(row?.deletedBy).toBe(await ctx.userId(USERS.yamada));
    expect(
      await ctx.db
        .select()
        .from(schema.projectMembers)
        .where(eq(schema.projectMembers.projectId, id)),
    ).toHaveLength(3);

    const again = await ctx.call("GET", `/api/projects/${id}`, { cookie });
    expect(again.status).toBe(404);
    expect(again.json.error.code).toBe("PROJECT_NOT_FOUND");
    expect((await ctx.call("DELETE", `/api/projects/${id}`, { cookie })).status).toBe(404);
    const list = await ctx.call("GET", "/api/projects", { cookie });
    expect(list.json.projects.map((p: { id: string }) => p.id)).not.toContain(id);
  });

  test("削除済みの案件は元メンバーにも 404、ID の形式が違っても 404", async () => {
    const deleted = await ctx.projectId("C社 業務改善");
    const cookie = await ctx.login(USERS.yamada);
    expect((await ctx.call("GET", `/api/projects/${deleted}`, { cookie })).json.error.code).toBe(
      "PROJECT_NOT_FOUND",
    );
    expect((await ctx.call("GET", "/api/projects/not-a-uuid", { cookie })).json.error.code).toBe(
      "PROJECT_NOT_FOUND",
    );
    expect(
      (await ctx.call("GET", "/api/projects/00000000-0000-0000-0000-000000000000", { cookie }))
        .status,
    ).toBe(404);
  });

  test("管理者であっても参加していない案件は 404(権限を足さない)", async () => {
    const id = await ctx.projectId("D社 研修企画");
    const reply = await ctx.call("GET", `/api/projects/${id}`, {
      cookie: await ctx.login(USERS.yamada),
    });
    expect(reply.status).toBe(404);
    expect(reply.json.error.code).toBe("PROJECT_NOT_FOUND");
  });
});
