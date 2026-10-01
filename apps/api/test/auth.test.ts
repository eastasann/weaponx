import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { createTestContext, USERS } from "./helpers";

const ctx = createTestContext();
beforeEach(() => ctx.seed());
afterAll(() => ctx.close());

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

describe("開発用ログイン", () => {
  test("一度でもログインした利用者だけを返す(停止中を含み、未ログインを含まない)", async () => {
    const reply = await ctx.call("GET", "/api/dev/users");
    expect(reply.status).toBe(200);
    const emails = reply.json.users.map((u: { email: string }) => u.email);
    expect(emails).toEqual([USERS.sato, USERS.suzuki, USERS.tanaka, USERS.yamada]);
    expect(reply.json.users.find((u: { email: string }) => u.email === USERS.suzuki).status).toBe(
      "suspended",
    );
  });

  test("ログインすると wx_session(HttpOnly・SameSite=Lax・Path=/)を返し、DB にはハッシュだけを置く", async () => {
    const reply = await ctx.call("POST", "/api/dev/login", {
      body: { email: "  Yamada@Example.com " },
    });
    expect(reply.status).toBe(204);
    const cookie = reply.headers.getSetCookie().find((c) => c.startsWith("wx_session=")) as string;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Secure");
    const token = cookie.split(";")[0]?.slice("wx_session=".length) as string;
    const [row] = await ctx.db.select().from(schema.sessions);
    expect(row?.id).toBe(sha256(token));
    expect(row?.id).not.toBe(token);
    const days = ((row?.expiresAt.getTime() ?? 0) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThanOrEqual(14);
  });

  test("ドライブ連携の記録は更新しない", async () => {
    const before = await ctx.db.select().from(schema.driveConnections);
    await ctx.login(USERS.tanaka);
    expect(await ctx.db.select().from(schema.driveConnections)).toEqual(before);
  });

  test("停止中は 401 ACCOUNT_SUSPENDED と wx_login_notice(suspended)で、セッションを作らない", async () => {
    const reply = await ctx.call("POST", "/api/dev/login", { body: { email: USERS.suzuki } });
    expect(reply.status).toBe(401);
    expect(reply.json.error.code).toBe("ACCOUNT_SUSPENDED");
    const notice = reply.headers
      .getSetCookie()
      .find((c) => c.startsWith("wx_login_notice=")) as string;
    expect(notice).not.toContain("HttpOnly");
    const value = notice.split(";")[0]?.slice("wx_login_notice=".length) as string;
    expect(JSON.parse(decodeURIComponent(value))).toEqual({ code: "suspended" });
    expect(await ctx.db.select().from(schema.sessions)).toHaveLength(0);
  });

  test("未ログインの利用者・存在しないメール・形式が違うメールは 404 NOT_FOUND", async () => {
    for (const email of [USERS.newcomer, "nobody@example.com", "not-an-email"]) {
      const reply = await ctx.call("POST", "/api/dev/login", { body: { email } });
      expect(reply.status).toBe(404);
      expect(reply.json.error.code).toBe("NOT_FOUND");
    }
  });

  test("DEV_LOGIN_ENABLED=false のときはルートが無い", async () => {
    const off = createTestContext({ DEV_LOGIN_ENABLED: "false" });
    try {
      expect((await off.call("GET", "/api/dev/users")).status).toBe(404);
      expect(
        (await off.call("POST", "/api/dev/login", { body: { email: USERS.yamada } })).status,
      ).toBe(404);
      expect((await off.call("GET", "/api/config")).json.devLogin).toBe(false);
    } finally {
      await off.close();
    }
  });

  test("ログインのたびに期限切れのセッションを消す", async () => {
    const yamada = await ctx.userId(USERS.yamada);
    await ctx.db.insert(schema.sessions).values({
      id: "expired",
      userId: yamada,
      expiresAt: new Date(Date.now() - 1000),
    });
    await ctx.login(USERS.sato);
    const ids = (await ctx.db.select().from(schema.sessions)).map((s) => s.id);
    expect(ids).not.toContain("expired");
    expect(ids).toHaveLength(1);
  });
});

describe("セッションのガード", () => {
  test("Cookie が無い・でたらめ・期限切れは 401 UNAUTHENTICATED", async () => {
    expect((await ctx.call("GET", "/api/me")).json.error.code).toBe("UNAUTHENTICATED");
    const bogus = await ctx.call("GET", "/api/me", { cookie: "wx_session=bogus" });
    expect(bogus.status).toBe(401);

    const cookie = await ctx.login(USERS.yamada);
    await ctx.db.update(schema.sessions).set({ expiresAt: new Date(Date.now() - 1000) });
    const expired = await ctx.call("GET", "/api/me", { cookie });
    expect(expired.status).toBe(401);
    expect(expired.json.error.code).toBe("UNAUTHENTICATED");
  });

  test("検証より先に認証を確かめる(未認証の不正な本文は 401)", async () => {
    const reply = await ctx.call("POST", "/api/projects", { body: {} });
    expect(reply.status).toBe(401);
  });

  test("残りが7日を切ったら14日に延長し、新しい Cookie を返す。それ以外は延長しない", async () => {
    const cookie = await ctx.login(USERS.yamada);
    const fresh = await ctx.call("GET", "/api/me", { cookie });
    expect(fresh.headers.getSetCookie()).toHaveLength(0);

    await ctx.db.update(schema.sessions).set({ expiresAt: new Date(Date.now() + 6 * 86_400_000) });
    const extended = await ctx.call("GET", "/api/me", { cookie });
    expect(extended.headers.getSetCookie().some((c) => c.startsWith("wx_session="))).toBe(true);
    const [row] = await ctx.db.select().from(schema.sessions);
    expect((row?.expiresAt.getTime() ?? 0) - Date.now()).toBeGreaterThan(13.9 * 86_400_000);
  });

  test("停止された人の次のリクエストは 401 ACCOUNT_SUSPENDED で、セッションを消し、通知の Cookie を付ける", async () => {
    const cookie = await ctx.login(USERS.sato);
    expect((await ctx.call("GET", "/api/me", { cookie })).status).toBe(200);
    await ctx.db
      .update(schema.users)
      .set({ status: "suspended" })
      .where(eq(schema.users.email, USERS.sato));

    const reply = await ctx.call("GET", "/api/projects", { cookie });
    expect(reply.status).toBe(401);
    expect(reply.json.error.code).toBe("ACCOUNT_SUSPENDED");
    const cookies = reply.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith("wx_login_notice="))).toBe(true);
    expect(cookies.some((c) => c.startsWith("wx_session=;") && c.includes("Max-Age=0"))).toBe(true);
    expect(await ctx.db.select().from(schema.sessions)).toHaveLength(0);

    expect((await ctx.call("GET", "/api/me", { cookie })).json.error.code).toBe("UNAUTHENTICATED");
  });

  test("停止しただけではセッションは消えない(次のリクエストで消す)", async () => {
    const cookie = await ctx.login(USERS.yamada);
    const sato = await ctx.userId(USERS.sato);
    await ctx.call("GET", "/api/me", { cookie: await ctx.login(USERS.sato) });
    const reply = await ctx.call("PATCH", `/api/admin/users/${sato}`, {
      cookie,
      body: { status: "suspended" },
    });
    expect(reply.status).toBe(200);
    expect(await ctx.db.select().from(schema.sessions)).toHaveLength(2);
  });
});

describe("ログアウト", () => {
  test("204 でセッションの行を消し、Cookie を消す。未認証は 401", async () => {
    expect((await ctx.call("POST", "/api/auth/logout")).status).toBe(401);
    const cookie = await ctx.login(USERS.yamada);
    const reply = await ctx.call("POST", "/api/auth/logout", { cookie });
    expect(reply.status).toBe(204);
    expect(reply.headers.getSetCookie().some((c) => c.startsWith("wx_session=;"))).toBe(true);
    expect(await ctx.db.select().from(schema.sessions)).toHaveLength(0);
    expect((await ctx.call("GET", "/api/me", { cookie })).status).toBe(401);
  });
});

describe("/api/me", () => {
  test("利用者とドライブ連携の状態を返す", async () => {
    const yamada = await ctx.call("GET", "/api/me", { cookie: await ctx.login(USERS.yamada) });
    expect(yamada.status).toBe(200);
    expect(yamada.json.user).toMatchObject({
      email: USERS.yamada,
      displayName: "山田 太郎",
      globalRole: "admin",
    });
    expect(yamada.json.drive).toEqual({ status: "active" });
    const tanaka = await ctx.call("GET", "/api/me", { cookie: await ctx.login(USERS.tanaka) });
    expect(tanaka.json.drive).toEqual({ status: "needs_reauth" });
  });

  test("PATCH で表示言語を変える。ja / en 以外は 422", async () => {
    const cookie = await ctx.login(USERS.yamada);
    const ok = await ctx.call("PATCH", "/api/me", { cookie, body: { locale: "en" } });
    expect(ok.status).toBe(200);
    expect(ok.json.user.locale).toBe("en");
    expect((await ctx.call("GET", "/api/me", { cookie })).json.user.locale).toBe("en");
    const bad = await ctx.call("PATCH", "/api/me", { cookie, body: { locale: "fr" } });
    expect(bad.status).toBe(422);
    expect(bad.json.error.details.fields).toEqual({ locale: "invalid_format" });
  });
});
