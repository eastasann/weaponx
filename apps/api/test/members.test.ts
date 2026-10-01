import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { createTestContext, USERS } from "./helpers";

const ctx = createTestContext();
beforeEach(() => ctx.seed());
afterAll(() => ctx.close());

async function roleOf(projectId: string, email: string) {
  const userId = await ctx.userId(email);
  const [row] = await ctx.db
    .select()
    .from(schema.projectMembers)
    .where(
      and(eq(schema.projectMembers.projectId, projectId), eq(schema.projectMembers.userId, userId)),
    );
  return row?.role;
}

describe("GET members", () => {
  test("オーナー、編集者、閲覧者の順で返し、停止中・未ログインの区別を持つ", async () => {
    const id = await ctx.projectId("A社 DX提案");
    const reply = await ctx.call("GET", `/api/projects/${id}/members`, {
      cookie: await ctx.login(USERS.sato),
    });
    expect(reply.status).toBe(200);
    expect(
      reply.json.members.map((m: { email: string; role: string }) => [m.email, m.role]),
    ).toEqual([
      [USERS.yamada, "owner"],
      [USERS.sato, "editor"],
      [USERS.suzuki, "viewer"],
    ]);
    const suzuki = reply.json.members[2];
    expect(suzuki).toMatchObject({
      status: "suspended",
      hasLoggedIn: true,
      displayName: "鈴木 一郎",
    });
    expect(typeof suzuki.addedAt).toBe("string");
  });

  test("閲覧者も一覧を見られる。不参加は 404", async () => {
    const id = await ctx.projectId("A社 DX提案");
    expect(
      (
        await ctx.call("GET", `/api/projects/${id}/members`, {
          cookie: await ctx.login(USERS.tanaka),
        })
      ).status,
    ).toBe(404);
  });
});

describe("GET member-candidates", () => {
  test("有効で、まだメンバーでない人だけを返す", async () => {
    const id = await ctx.projectId("A社 DX提案");
    const reply = await ctx.call("GET", `/api/projects/${id}/member-candidates`, {
      cookie: await ctx.login(USERS.yamada),
    });
    expect(reply.status).toBe(200);
    // 佐藤・鈴木(停止中)・山田は除き、田中と未ログインの new@ が残る
    expect(reply.json.users.map((u: { email: string }) => u.email).sort()).toEqual(
      [USERS.newcomer, USERS.tanaka].sort(),
    );
  });

  test("名前かメールの部分一致で、大文字小文字と全角半角を区別しない。ワイルドカードは文字として扱う", async () => {
    const id = await ctx.projectId("A社 DX提案");
    const cookie = await ctx.login(USERS.yamada);
    const byName = await ctx.call(
      "GET",
      `/api/projects/${id}/member-candidates?q=${encodeURIComponent("美咲")}`,
      { cookie },
    );
    expect(byName.json.users.map((u: { email: string }) => u.email)).toEqual([USERS.tanaka]);
    const byMail = await ctx.call("GET", `/api/projects/${id}/member-candidates?q=NEW@`, {
      cookie,
    });
    expect(byMail.json.users.map((u: { email: string }) => u.email)).toEqual([USERS.newcomer]);
    const wide = await ctx.call(
      "GET",
      `/api/projects/${id}/member-candidates?q=${encodeURIComponent("ＴＡＮＡＫＡ")}`,
      { cookie },
    );
    expect(wide.json.users).toHaveLength(1);
    const wildcard = await ctx.call(
      "GET",
      `/api/projects/${id}/member-candidates?q=${encodeURIComponent("%")}`,
      { cookie },
    );
    expect(wildcard.json.users).toHaveLength(0);
  });

  test("件数は 20 件まで。語が長すぎれば 422", async () => {
    const id = await ctx.projectId("A社 DX提案");
    const cookie = await ctx.login(USERS.yamada);
    await ctx.db
      .insert(schema.users)
      .values(Array.from({ length: 25 }, (_, i) => ({ email: `bulk${i}@example.com` })));
    const reply = await ctx.call("GET", `/api/projects/${id}/member-candidates`, { cookie });
    expect(reply.json.users).toHaveLength(20);
    const long = await ctx.call(
      "GET",
      `/api/projects/${id}/member-candidates?q=${"a".repeat(101)}`,
      { cookie },
    );
    expect(long.status).toBe(422);
    expect(long.json.error.details.fields).toEqual({ q: "too_long" });
  });
});

describe("POST members", () => {
  test("オーナーが招待すると 201 で、added_by が入る", async () => {
    const id = await ctx.projectId("A社 DX提案");
    const tanaka = await ctx.userId(USERS.tanaka);
    const reply = await ctx.call("POST", `/api/projects/${id}/members`, {
      cookie: await ctx.login(USERS.yamada),
      body: { userId: tanaka, role: "editor" },
    });
    expect(reply.status).toBe(201);
    expect(reply.json.member).toMatchObject({
      userId: tanaka,
      email: USERS.tanaka,
      role: "editor",
    });
    expect(await roleOf(id, USERS.tanaka)).toBe("editor");
    const [row] = await ctx.db
      .select()
      .from(schema.projectMembers)
      .where(
        and(eq(schema.projectMembers.projectId, id), eq(schema.projectMembers.userId, tanaka)),
      );
    expect(row?.addedBy).toBe(await ctx.userId(USERS.yamada));
  });

  test("すでにメンバー(409 ALREADY_MEMBER)・停止中(422 USER_SUSPENDED)・存在しない利用者(404)", async () => {
    const id = await ctx.projectId("B社 市場調査");
    const cookie = await ctx.login(USERS.sato);
    const dup = await ctx.call("POST", `/api/projects/${id}/members`, {
      cookie,
      body: { userId: await ctx.userId(USERS.yamada), role: "viewer" },
    });
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe("ALREADY_MEMBER");
    expect(dup.json.error.details.userId).toBe(await ctx.userId(USERS.yamada));

    const suzuki = await ctx.userId(USERS.suzuki);
    const suspended = await ctx.call("POST", `/api/projects/${id}/members`, {
      cookie,
      body: { userId: suzuki, role: "viewer" },
    });
    expect(suspended.status).toBe(422);
    expect(suspended.json.error).toMatchObject({
      code: "USER_SUSPENDED",
      details: { userId: suzuki },
    });

    const missing = await ctx.call("POST", `/api/projects/${id}/members`, {
      cookie,
      body: { userId: "00000000-0000-0000-0000-000000000000", role: "viewer" },
    });
    expect(missing.status).toBe(404);
    const malformed = await ctx.call("POST", `/api/projects/${id}/members`, {
      cookie,
      body: { userId: "x", role: "viewer" },
    });
    expect(malformed.status).toBe(404);
  });

  test("同時に同じ人を招待しても、片方だけが成功し、もう片方は ALREADY_MEMBER", async () => {
    const id = await ctx.projectId("A社 DX提案");
    const cookie = await ctx.login(USERS.yamada);
    const tanaka = await ctx.userId(USERS.tanaka);
    const replies = await Promise.all(
      [0, 1, 2].map(() =>
        ctx.call("POST", `/api/projects/${id}/members`, {
          cookie,
          body: { userId: tanaka, role: "viewer" },
        }),
      ),
    );
    expect(replies.map((r) => r.status).sort()).toEqual([201, 409, 409]);
  });
});

describe("PATCH members", () => {
  test("役割を変える。同じ役割への変更は成功", async () => {
    const id = await ctx.projectId("A社 DX提案");
    const cookie = await ctx.login(USERS.yamada);
    const sato = await ctx.userId(USERS.sato);
    const changed = await ctx.call("PATCH", `/api/projects/${id}/members/${sato}`, {
      cookie,
      body: { role: "viewer" },
    });
    expect(changed.status).toBe(200);
    expect(changed.json.member.role).toBe("viewer");
    expect(await roleOf(id, USERS.sato)).toBe("viewer");
    const same = await ctx.call("PATCH", `/api/projects/${id}/members/${sato}`, {
      cookie,
      body: { role: "viewer" },
    });
    expect(same.status).toBe(200);
  });

  test("最後のオーナーは自分でも下げられない(409 LAST_OWNER)。オーナーが2人いれば下げられる", async () => {
    const id = await ctx.projectId("A社 DX提案");
    const cookie = await ctx.login(USERS.yamada);
    const yamada = await ctx.userId(USERS.yamada);
    const blocked = await ctx.call("PATCH", `/api/projects/${id}/members/${yamada}`, {
      cookie,
      body: { role: "editor" },
    });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error.code).toBe("LAST_OWNER");
    expect(await roleOf(id, USERS.yamada)).toBe("owner");

    const sato = await ctx.userId(USERS.sato);
    await ctx.call("PATCH", `/api/projects/${id}/members/${sato}`, {
      cookie,
      body: { role: "owner" },
    });
    const ok = await ctx.call("PATCH", `/api/projects/${id}/members/${yamada}`, {
      cookie,
      body: { role: "editor" },
    });
    expect(ok.status).toBe(200);
    // 自分を下げた後は、メンバーの管理ができない
    const after = await ctx.call("PATCH", `/api/projects/${id}/members/${sato}`, {
      cookie,
      body: { role: "viewer" },
    });
    expect(after.status).toBe(403);
    expect(after.json.error.code).toBe("ROLE_INSUFFICIENT");
  });

  test("メンバーでない人は 404 MEMBER_NOT_FOUND", async () => {
    const id = await ctx.projectId("A社 DX提案");
    const reply = await ctx.call(
      "PATCH",
      `/api/projects/${id}/members/${await ctx.userId(USERS.tanaka)}`,
      {
        cookie: await ctx.login(USERS.yamada),
        body: { role: "viewer" },
      },
    );
    expect(reply.status).toBe(404);
    expect(reply.json.error.code).toBe("MEMBER_NOT_FOUND");
  });

  test("2人のオーナーが同時に互いを下げても、オーナーが0人にならない", async () => {
    const id = await ctx.projectId("A社 DX提案");
    const yamada = await ctx.userId(USERS.yamada);
    const sato = await ctx.userId(USERS.sato);
    await ctx.db
      .update(schema.projectMembers)
      .set({ role: "owner" })
      .where(and(eq(schema.projectMembers.projectId, id), eq(schema.projectMembers.userId, sato)));
    const [yCookie, sCookie] = [await ctx.login(USERS.yamada), await ctx.login(USERS.sato)];
    for (let i = 0; i < 5; i++) {
      await ctx.db
        .update(schema.projectMembers)
        .set({ role: "owner" })
        .where(
          and(
            eq(schema.projectMembers.projectId, id),
            inArray(schema.projectMembers.userId, [yamada, sato]),
          ),
        );
      const [a, b] = await Promise.all([
        ctx.call("PATCH", `/api/projects/${id}/members/${sato}`, {
          cookie: yCookie,
          body: { role: "viewer" },
        }),
        ctx.call("PATCH", `/api/projects/${id}/members/${yamada}`, {
          cookie: sCookie,
          body: { role: "viewer" },
        }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 403]);
      const owners = await ctx.db
        .select()
        .from(schema.projectMembers)
        .where(
          and(eq(schema.projectMembers.projectId, id), eq(schema.projectMembers.role, "owner")),
        );
      expect(owners).toHaveLength(1);
    }
  });
});

describe("DELETE members", () => {
  test("メンバーから外すと行を消す。外された人は 404", async () => {
    const id = await ctx.projectId("A社 DX提案");
    const sato = await ctx.userId(USERS.sato);
    const satoCookie = await ctx.login(USERS.sato);
    const reply = await ctx.call("DELETE", `/api/projects/${id}/members/${sato}`, {
      cookie: await ctx.login(USERS.yamada),
    });
    expect(reply.status).toBe(204);
    expect(await roleOf(id, USERS.sato)).toBeUndefined();
    expect(
      (await ctx.call("GET", `/api/projects/${id}`, { cookie: satoCookie })).json.error.code,
    ).toBe("PROJECT_NOT_FOUND");
    const again = await ctx.call("DELETE", `/api/projects/${id}/members/${sato}`, {
      cookie: await ctx.login(USERS.yamada),
    });
    expect(again.status).toBe(404);
    expect(again.json.error.code).toBe("MEMBER_NOT_FOUND");
  });

  test("最後のオーナーは自分を外せない(LAST_OWNER)。オーナーが2人なら自分を外せる", async () => {
    const id = await ctx.projectId("A社 DX提案");
    const cookie = await ctx.login(USERS.yamada);
    const yamada = await ctx.userId(USERS.yamada);
    const blocked = await ctx.call("DELETE", `/api/projects/${id}/members/${yamada}`, { cookie });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error.code).toBe("LAST_OWNER");
    await ctx.call("PATCH", `/api/projects/${id}/members/${await ctx.userId(USERS.sato)}`, {
      cookie,
      body: { role: "owner" },
    });
    expect(
      (await ctx.call("DELETE", `/api/projects/${id}/members/${yamada}`, { cookie })).status,
    ).toBe(204);
  });

  test("最後のオーナーを同時に外そうとしても、オーナーが0人にならない", async () => {
    const id = await ctx.projectId("A社 DX提案");
    const yamada = await ctx.userId(USERS.yamada);
    const sato = await ctx.userId(USERS.sato);
    await ctx.db
      .update(schema.projectMembers)
      .set({ role: "owner" })
      .where(and(eq(schema.projectMembers.projectId, id), eq(schema.projectMembers.userId, sato)));
    const [yCookie, sCookie] = [await ctx.login(USERS.yamada), await ctx.login(USERS.sato)];
    const [a, b] = await Promise.all([
      ctx.call("DELETE", `/api/projects/${id}/members/${sato}`, { cookie: yCookie }),
      ctx.call("DELETE", `/api/projects/${id}/members/${yamada}`, { cookie: sCookie }),
    ]);
    // 先に処理された側が相手を外し、後の側は案件のメンバーでなくなっているので 404
    expect([a.status, b.status].sort()).toEqual([204, 404]);
    const owners = await ctx.db
      .select()
      .from(schema.projectMembers)
      .where(and(eq(schema.projectMembers.projectId, id), eq(schema.projectMembers.role, "owner")));
    expect(owners).toHaveLength(1);
  });
});
