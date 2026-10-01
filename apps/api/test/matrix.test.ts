/**
 * 02-01 7章の権限マトリクスのうち、この段階のエンドポイントの行を、役割ごとに叩いて確かめる。
 * 状態を変える操作は、成功したときに次の行へ影響しないよう毎回シードし直す。
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { createTestContext, USERS } from "./helpers";

const ctx = createTestContext();
beforeEach(() => ctx.seed());
afterAll(() => ctx.close());

type Who = "anon" | "outsider" | "viewer" | "editor" | "owner";

/**
 * 「A社 DX提案」での役割: 山田がオーナー、佐藤が編集者。閲覧者(鈴木)は停止中なので、
 * 田中を閲覧者として入れる。不参加は、ログイン済みでどの案件にも入っていない人を用意する。
 */
async function cookieFor(who: Who): Promise<string | undefined> {
  switch (who) {
    case "anon":
      return undefined;
    case "owner":
      return ctx.login(USERS.yamada);
    case "editor":
      return ctx.login(USERS.sato);
    case "viewer":
      await ctx.db.insert(schema.projectMembers).values({
        projectId: await ctx.projectId("A社 DX提案"),
        userId: await ctx.userId(USERS.tanaka),
        role: "viewer",
      });
      return ctx.login(USERS.tanaka);
    case "outsider":
      await ctx.db
        .update(schema.users)
        .set({ googleSubject: "demo-newcomer" })
        .where(eq(schema.users.email, USERS.newcomer));
      return ctx.login(USERS.newcomer);
  }
}

type Row = {
  label: string;
  method: string;
  path: (ids: { project: string; other: string; sato: string; tanaka: string }) => string;
  body?: (ids: { sato: string; tanaka: string }) => unknown;
  /** 役割ごとの期待する HTTP ステータス */
  expect: Record<Who, number>;
};

const rows: Row[] = [
  {
    label: "案件の取得",
    method: "GET",
    path: (i) => `/api/projects/${i.project}`,
    expect: { anon: 401, outsider: 404, viewer: 200, editor: 200, owner: 200 },
  },
  {
    label: "案件名の変更",
    method: "PATCH",
    path: (i) => `/api/projects/${i.project}`,
    body: () => ({ name: "変更後" }),
    expect: { anon: 401, outsider: 404, viewer: 403, editor: 403, owner: 200 },
  },
  {
    label: "案件の削除",
    method: "DELETE",
    path: (i) => `/api/projects/${i.project}`,
    expect: { anon: 401, outsider: 404, viewer: 403, editor: 403, owner: 204 },
  },
  {
    label: "メンバー一覧",
    method: "GET",
    path: (i) => `/api/projects/${i.project}/members`,
    expect: { anon: 401, outsider: 404, viewer: 200, editor: 200, owner: 200 },
  },
  {
    label: "招待の候補",
    method: "GET",
    path: (i) => `/api/projects/${i.project}/member-candidates`,
    expect: { anon: 401, outsider: 404, viewer: 403, editor: 403, owner: 200 },
  },
  {
    label: "招待",
    method: "POST",
    path: (i) => `/api/projects/${i.project}/members`,
    body: (i) => ({ userId: i.tanaka, role: "viewer" }),
    expect: { anon: 401, outsider: 404, viewer: 403, editor: 403, owner: 201 },
  },
  {
    label: "役割の変更",
    method: "PATCH",
    path: (i) => `/api/projects/${i.project}/members/${i.sato}`,
    body: () => ({ role: "viewer" }),
    expect: { anon: 401, outsider: 404, viewer: 403, editor: 403, owner: 200 },
  },
  {
    label: "メンバーを外す",
    method: "DELETE",
    path: (i) => `/api/projects/${i.project}/members/${i.sato}`,
    expect: { anon: 401, outsider: 404, viewer: 403, editor: 403, owner: 204 },
  },
];

describe("案件・メンバーの権限マトリクス", () => {
  for (const row of rows) {
    for (const [who, status] of Object.entries(row.expect) as [Who, number][]) {
      test(`${row.label}: ${who} は ${status}`, async () => {
        const cookie = await cookieFor(who);
        const ids = {
          project: await ctx.projectId("A社 DX提案"),
          other: await ctx.projectId("D社 研修企画"),
          sato: await ctx.userId(USERS.sato),
          tanaka: await ctx.userId(USERS.tanaka),
        };
        const reply = await ctx.call(row.method, row.path(ids), { cookie, body: row.body?.(ids) });
        expect(reply.status).toBe(status);
        if (status === 404) expect(reply.json.error.code).toBe("PROJECT_NOT_FOUND");
        if (status === 403) expect(reply.json.error.code).toBe("ROLE_INSUFFICIENT");
        if (status === 401) expect(reply.json.error.code).toBe("UNAUTHENTICATED");
      });
    }
  }

  test("入力の検証より先に認可を確かめる(不正な入力でも 404 / 403 を返す)", async () => {
    const project = await ctx.projectId("A社 DX提案");
    const sato = await ctx.userId(USERS.sato);
    const outsider = (await cookieFor("outsider")) as string;
    const viewer = (await cookieFor("viewer")) as string;
    const tooLong = "あ".repeat(101);
    const cases: [string, string, string | undefined, number, unknown?][] = [
      ["PATCH", `/api/projects/${project}`, outsider, 404, { name: tooLong }],
      ["PATCH", `/api/projects/${project}`, viewer, 403, { name: tooLong }],
      ["GET", `/api/projects/${project}/member-candidates?q=${tooLong}`, outsider, 404],
      ["GET", `/api/projects/${project}/member-candidates?q=${tooLong}`, viewer, 403],
      ["PATCH", `/api/projects/${project}/members/not-a-uuid`, outsider, 404, { role: "viewer" }],
      ["PATCH", `/api/projects/${project}/members/not-a-uuid`, viewer, 403, { role: "viewer" }],
      ["DELETE", `/api/projects/${project}/members/not-a-uuid`, outsider, 404],
      [
        "POST",
        `/api/projects/${project}/members`,
        viewer,
        403,
        { userId: "not-a-uuid", role: "viewer" },
      ],
      ["DELETE", `/api/projects/${project}/members/${sato}`, viewer, 403],
    ];
    for (const [method, path, cookie, status, body] of cases) {
      const reply = await ctx.call(method, path, { cookie, body });
      expect([method, path, reply.status]).toEqual([method, path, status]);
      expect(reply.json.error.code).toBe(
        status === 404 ? "PROJECT_NOT_FOUND" : "ROLE_INSUFFICIENT",
      );
    }
  });

  test("管理者(山田)は参加していない案件のどの操作も 404(管理者は案件の権限を足さない)", async () => {
    const cookie = await ctx.login(USERS.yamada);
    const other = await ctx.projectId("D社 研修企画");
    const tanaka = await ctx.userId(USERS.tanaka);
    const calls: [string, string, unknown?][] = [
      ["GET", `/api/projects/${other}`],
      ["PATCH", `/api/projects/${other}`, { name: "x" }],
      ["DELETE", `/api/projects/${other}`],
      ["GET", `/api/projects/${other}/members`],
      ["GET", `/api/projects/${other}/member-candidates`],
      ["POST", `/api/projects/${other}/members`, { userId: tanaka, role: "viewer" }],
      ["PATCH", `/api/projects/${other}/members/${tanaka}`, { role: "viewer" }],
      ["DELETE", `/api/projects/${other}/members/${tanaka}`],
    ];
    for (const [method, path, body] of calls) {
      const reply = await ctx.call(method, path, { cookie, body });
      expect([method, path, reply.status]).toEqual([method, path, 404]);
      expect(reply.json.error.code).toBe("PROJECT_NOT_FOUND");
    }
  });
});

describe("認証だけが要るエンドポイントとログイン不要のエンドポイント", () => {
  test("未認証は 401、認証済みは 200", async () => {
    const needAuth: [string, string, unknown?][] = [
      ["GET", "/api/me"],
      ["PATCH", "/api/me", { locale: "ja" }],
      ["GET", "/api/projects"],
      ["POST", "/api/projects", { name: "x" }],
      ["POST", "/api/auth/logout"],
    ];
    const cookie = await ctx.login(USERS.sato);
    for (const [method, path, body] of needAuth) {
      expect([method, path, (await ctx.call(method, path, { body })).status]).toEqual([
        method,
        path,
        401,
      ]);
      const ok = await ctx.call(method, path, { cookie, body });
      expect(ok.status).toBeLessThan(300);
    }
    for (const path of ["/api/healthz", "/api/readyz", "/api/config"]) {
      expect((await ctx.call("GET", path)).status).toBe(200);
    }
  });
});

describe("利用者管理の権限マトリクス", () => {
  const calls = (ids: { sato: string }): [string, string, unknown?][] => [
    ["GET", "/api/admin/users"],
    ["POST", "/api/admin/users", { email: "added@example.com" }],
    ["PATCH", `/api/admin/users/${ids.sato}`, { status: "active" }],
    ["GET", `/api/admin/users/${ids.sato}/sole-owner-count`],
  ];

  test("未認証は 401、一般の利用者(どの案件の役割でも)は 403 ADMIN_REQUIRED、管理者は成功", async () => {
    const ids = { sato: await ctx.userId(USERS.sato) };
    for (const [method, path, body] of calls(ids)) {
      expect((await ctx.call(method, path, { body })).status).toBe(401);
    }
    for (const email of [USERS.sato, USERS.tanaka]) {
      const cookie = await ctx.login(email);
      for (const [method, path, body] of calls(ids)) {
        const reply = await ctx.call(method, path, { cookie, body });
        expect([method, path, reply.status]).toEqual([method, path, 403]);
        expect(reply.json.error.code).toBe("ADMIN_REQUIRED");
      }
    }
    const admin = await ctx.login(USERS.yamada);
    for (const [method, path, body] of calls(ids)) {
      expect((await ctx.call(method, path, { cookie: admin, body })).status).toBeLessThan(300);
    }
  });

  test("管理者でない人に、検証より先に 403 を返す(不正な本文でも 403)", async () => {
    const cookie = await ctx.login(USERS.sato);
    const reply = await ctx.call("POST", "/api/admin/users", { cookie, body: { email: 1 } });
    expect(reply.status).toBe(403);
  });
});
