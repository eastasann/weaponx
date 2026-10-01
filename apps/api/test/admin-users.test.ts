import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { bootstrapAdmin, updateUser } from "../src/domain/users";
import { createTestContext, USERS } from "./helpers";

const ctx = createTestContext();
beforeEach(() => ctx.seed());
afterAll(() => ctx.close());

describe("GET /api/admin/users", () => {
  test("全利用者を返す(未ログイン・停止中を含む)", async () => {
    const reply = await ctx.call("GET", "/api/admin/users", {
      cookie: await ctx.login(USERS.yamada),
    });
    expect(reply.status).toBe(200);
    expect(reply.json.users).toHaveLength(5);
    const byEmail = Object.fromEntries(
      reply.json.users.map((u: { email: string }) => [u.email, u]),
    );
    expect(byEmail[USERS.newcomer]).toMatchObject({
      displayName: null,
      globalRole: "member",
      status: "active",
      hasLoggedIn: false,
      lastLoginAt: null,
    });
    expect(byEmail[USERS.suzuki]).toMatchObject({ status: "suspended", hasLoggedIn: true });
    expect(byEmail[USERS.yamada]).toMatchObject({ globalRole: "admin" });
  });
});

describe("POST /api/admin/users", () => {
  test("メールを小文字にして登録し、管理者にもできる", async () => {
    const cookie = await ctx.login(USERS.yamada);
    const reply = await ctx.call("POST", "/api/admin/users", {
      cookie,
      body: { email: "  Kato@Example.com ", admin: true },
    });
    expect(reply.status).toBe(201);
    expect(reply.json.user).toMatchObject({
      email: "kato@example.com",
      globalRole: "admin",
      status: "active",
      hasLoggedIn: false,
    });
    const plain = await ctx.call("POST", "/api/admin/users", {
      cookie,
      body: { email: "ito@example.com" },
    });
    expect(plain.json.user.globalRole).toBe("member");
    const [row] = await ctx.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, "ito@example.com"));
    expect(row?.createdBy).toBe(await ctx.userId(USERS.yamada));
  });

  test("登録済みは 409 EMAIL_TAKEN(大文字小文字を区別しない)、形式の誤りは 422", async () => {
    const cookie = await ctx.login(USERS.yamada);
    const dup = await ctx.call("POST", "/api/admin/users", {
      cookie,
      body: { email: "SATO@example.com" },
    });
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe("EMAIL_TAKEN");
    const bad = await ctx.call("POST", "/api/admin/users", { cookie, body: { email: "nope" } });
    expect(bad.status).toBe(422);
    expect(bad.json.error.details.fields).toEqual({ email: "invalid_format" });
    const empty = await ctx.call("POST", "/api/admin/users", { cookie, body: { email: " " } });
    expect(empty.json.error.details.fields).toEqual({ email: "required" });
  });

  test("同時に同じメールを登録しても、片方だけが成功する", async () => {
    const cookie = await ctx.login(USERS.yamada);
    const replies = await Promise.all(
      [0, 1, 2].map(() =>
        ctx.call("POST", "/api/admin/users", { cookie, body: { email: "race@example.com" } }),
      ),
    );
    expect(replies.map((r) => r.status).sort()).toEqual([201, 409, 409]);
  });
});

describe("PATCH /api/admin/users/:userId", () => {
  test("停止・再開・管理者の付与と解除。同じ結果になる操作は成功", async () => {
    const cookie = await ctx.login(USERS.yamada);
    const sato = await ctx.userId(USERS.sato);
    const url = `/api/admin/users/${sato}`;
    expect(
      (await ctx.call("PATCH", url, { cookie, body: { status: "suspended" } })).json.user.status,
    ).toBe("suspended");
    expect((await ctx.call("PATCH", url, { cookie, body: { status: "suspended" } })).status).toBe(
      200,
    );
    expect(
      (await ctx.call("PATCH", url, { cookie, body: { status: "active" } })).json.user.status,
    ).toBe("active");
    expect((await ctx.call("PATCH", url, { cookie, body: { status: "active" } })).status).toBe(200);
    expect(
      (await ctx.call("PATCH", url, { cookie, body: { globalRole: "admin" } })).json.user
        .globalRole,
    ).toBe("admin");
    expect(
      (await ctx.call("PATCH", url, { cookie, body: { globalRole: "member" } })).json.user
        .globalRole,
    ).toBe("member");
  });

  test("本文が空・未知の値は 422", async () => {
    const cookie = await ctx.login(USERS.yamada);
    const url = `/api/admin/users/${await ctx.userId(USERS.sato)}`;
    expect((await ctx.call("PATCH", url, { cookie, body: {} })).status).toBe(422);
    expect((await ctx.call("PATCH", url, { cookie, body: { status: "gone" } })).status).toBe(422);
  });

  test("自分自身は 422 SELF_CHANGE_FORBIDDEN。存在しない利用者は 404", async () => {
    const cookie = await ctx.login(USERS.yamada);
    const self = await ctx.call("PATCH", `/api/admin/users/${await ctx.userId(USERS.yamada)}`, {
      cookie,
      body: { status: "suspended" },
    });
    expect(self.status).toBe(422);
    expect(self.json.error.code).toBe("SELF_CHANGE_FORBIDDEN");
    const missing = await ctx.call(
      "PATCH",
      "/api/admin/users/00000000-0000-0000-0000-000000000000",
      { cookie, body: { status: "active" } },
    );
    expect(missing.status).toBe(404);
    expect(missing.json.error.code).toBe("NOT_FOUND");
  });

  test("最後の有効な管理者は外せない・停止できない(409 LAST_ADMIN)", async () => {
    // 呼び出し側は別の有効な管理者がいる状態でしか来ないので、ドメインを直接呼んで確かめる。
    // HTTP で届くのは、操作の途中で呼び出した管理者が外された競合のとき(次のテスト)
    const yamada = await ctx.userId(USERS.yamada);
    const sato = await ctx.userId(USERS.sato);
    await expect(updateUser(ctx.db, sato, yamada, { status: "suspended" })).rejects.toMatchObject({
      code: "LAST_ADMIN",
    });
    await expect(updateUser(ctx.db, sato, yamada, { globalRole: "member" })).rejects.toMatchObject({
      code: "LAST_ADMIN",
    });
    await expect(
      updateUser(ctx.db, sato, yamada, { status: "suspended", globalRole: "member" }),
    ).rejects.toMatchObject({ code: "LAST_ADMIN" });
    const [row] = await ctx.db.select().from(schema.users).where(eq(schema.users.id, yamada));
    expect(row).toMatchObject({ globalRole: "admin", status: "active" });
  });

  test("停止中の管理者を外しても、有効な管理者の数は変わらないので成功する", async () => {
    const suzuki = await ctx.userId(USERS.suzuki);
    await ctx.db
      .update(schema.users)
      .set({ globalRole: "admin" })
      .where(eq(schema.users.id, suzuki));
    const reply = await ctx.call("PATCH", `/api/admin/users/${suzuki}`, {
      cookie: await ctx.login(USERS.yamada),
      body: { globalRole: "member" },
    });
    expect(reply.status).toBe(200);
  });

  test("2人の管理者が同時に互いを外しても、有効な管理者が0人にならない", async () => {
    const yamada = await ctx.userId(USERS.yamada);
    const sato = await ctx.userId(USERS.sato);
    await ctx.db.update(schema.users).set({ globalRole: "admin" }).where(eq(schema.users.id, sato));
    const [yCookie, sCookie] = [await ctx.login(USERS.yamada), await ctx.login(USERS.sato)];
    const [a, b] = await Promise.all([
      ctx.call("PATCH", `/api/admin/users/${sato}`, {
        cookie: yCookie,
        body: { globalRole: "member" },
      }),
      ctx.call("PATCH", `/api/admin/users/${yamada}`, {
        cookie: sCookie,
        body: { globalRole: "member" },
      }),
    ]);
    const admins = await ctx.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.globalRole, "admin"));
    expect(admins.filter((u) => u.status === "active").length).toBeGreaterThanOrEqual(1);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });
});

describe("GET /api/admin/users/:userId/sole-owner-count", () => {
  test("唯一のオーナーになっている、削除されていない案件の数だけを返す", async () => {
    const cookie = await ctx.login(USERS.yamada);
    const count = async (email: string) =>
      (
        await ctx.call("GET", `/api/admin/users/${await ctx.userId(email)}/sole-owner-count`, {
          cookie,
        })
      ).json;
    // 山田は A社 DX提案の唯一のオーナー(C社は削除済みなので数えない)
    expect(await count(USERS.yamada)).toEqual({ count: 1 });
    // 鈴木は D社 研修企画の唯一のオーナー
    expect(await count(USERS.suzuki)).toEqual({ count: 1 });
    expect(await count(USERS.sato)).toEqual({ count: 1 });
    expect(await count(USERS.newcomer)).toEqual({ count: 0 });
  });

  test("オーナーが複数いれば数えない。存在しない利用者は 404", async () => {
    const cookie = await ctx.login(USERS.yamada);
    await ctx.db
      .update(schema.projectMembers)
      .set({ role: "owner" })
      .where(eq(schema.projectMembers.userId, await ctx.userId(USERS.sato)));
    expect(
      (
        await ctx.call(
          "GET",
          `/api/admin/users/${await ctx.userId(USERS.yamada)}/sole-owner-count`,
          { cookie },
        )
      ).json.count,
    ).toBe(0);
    expect(
      (
        await ctx.call(
          "GET",
          "/api/admin/users/00000000-0000-0000-0000-000000000000/sole-owner-count",
          { cookie },
        )
      ).status,
    ).toBe(404);
  });
});

describe("bootstrapAdmin(make bootstrap-admin)", () => {
  test("管理者が1人もいなければ登録し、いれば何もしない", async () => {
    expect(await bootstrapAdmin(ctx.db, "root@example.com")).toBe("skipped");
    expect(
      await ctx.db.select().from(schema.users).where(eq(schema.users.email, "root@example.com")),
    ).toHaveLength(0);

    await ctx.db.update(schema.users).set({ globalRole: "member" });
    expect(await bootstrapAdmin(ctx.db, "root@example.com")).toBe("created");
    const [root] = await ctx.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, "root@example.com"));
    expect(root).toMatchObject({ globalRole: "admin", status: "active", googleSubject: null });
    expect(await bootstrapAdmin(ctx.db, "other@example.com")).toBe("skipped");
  });

  test("同じメールの利用者がいれば、有効な管理者にする", async () => {
    await ctx.db.update(schema.users).set({ globalRole: "member" });
    expect(await bootstrapAdmin(ctx.db, USERS.suzuki)).toBe("promoted");
    const [suzuki] = await ctx.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, USERS.suzuki));
    expect(suzuki).toMatchObject({ globalRole: "admin", status: "active" });
  });

  test("同時に実行しても、管理者は1人だけ登録される", async () => {
    await ctx.db.update(schema.users).set({ globalRole: "member" });
    const results = await Promise.all([
      bootstrapAdmin(ctx.db, "a@example.com"),
      bootstrapAdmin(ctx.db, "b@example.com"),
      bootstrapAdmin(ctx.db, "c@example.com"),
    ]);
    expect(results.filter((r) => r === "created")).toHaveLength(1);
    expect(
      await ctx.db.select().from(schema.users).where(eq(schema.users.globalRole, "admin")),
    ).toHaveLength(1);
  });
});
