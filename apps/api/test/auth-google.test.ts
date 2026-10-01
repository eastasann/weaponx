import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { decryptToken } from "../src/auth/token-crypto";
import * as schema from "../src/db/schema";
import { cookieHeader, createTestContext, type Json, type Reply, USERS } from "./helpers";

const CLIENT_ID = "client-1.apps.googleusercontent.com";
const google = {
  GOOGLE_CLIENT_ID: CLIENT_ID,
  GOOGLE_CLIENT_SECRET: "client-secret",
  GOOGLE_PICKER_API_KEY: "AIza-test",
  GOOGLE_PROJECT_NUMBER: "123456789012",
};
const ctx = createTestContext({ ...google, DRIVE_MODE: "google" });
const realFetch = globalThis.fetch;
let tokenResponse: () => Response;
let tokenRequests: URLSearchParams[];

beforeEach(async () => {
  await ctx.seed();
  ctx.logs.length = 0;
  tokenRequests = [];
  // Arctic はグローバルの fetch でトークンエンドポイントを呼ぶ
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    expect(request.url).toBe("https://oauth2.googleapis.com/token");
    tokenRequests.push(new URLSearchParams(await request.text()));
    return tokenResponse();
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
afterAll(() => ctx.close());

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const ALL_SCOPES = `openid email profile ${DRIVE_SCOPE}`;

function idToken(claims: Record<string, unknown>): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const base = {
    sub: "google-sub-new",
    email: USERS.newcomer,
    email_verified: true,
    name: "新田 太郎",
    picture: "https://lh3.googleusercontent.com/a/new",
    aud: CLIENT_ID,
    iss: "https://accounts.google.com",
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  return `${part({ alg: "RS256" })}.${part({ ...base, ...claims })}.sig`;
}

function respondWith(options: {
  claims?: Record<string, unknown>;
  scope?: string;
  refreshToken?: string | null;
}) {
  tokenResponse = () =>
    new Response(
      JSON.stringify({
        access_token: "ya29.access",
        expires_in: 3600,
        token_type: "Bearer",
        scope: options.scope ?? ALL_SCOPES,
        id_token: idToken(options.claims ?? {}),
        ...(options.refreshToken === null
          ? {}
          : { refresh_token: options.refreshToken ?? "1//refresh-new" }),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
}

/** `/login` から Google への送り先までを進め、`callback` に持ち込む Cookie と state を返す */
async function startLogin(query = "") {
  const reply = await ctx.call("GET", `/api/auth/google/login${query}`);
  expect(reply.status).toBe(302);
  const url = new URL(reply.headers.get("location") as string);
  return { reply, url, cookie: cookieHeader(reply.headers), state: url.searchParams.get("state") };
}

function callback(cookie: string, params: Record<string, string>, session = "") {
  const query = new URLSearchParams(params);
  return ctx.call("GET", `/api/auth/google/callback?${query}`, {
    cookie: [cookie, session].filter(Boolean).join("; "),
  });
}

function notice(reply: Reply, name: string): Json | null {
  const raw = reply.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  return raw
    ? JSON.parse(decodeURIComponent((raw.split(";")[0] as string).slice(name.length + 1)))
    : null;
}

const setCookies = (reply: Reply) => reply.headers.getSetCookie();
const sessionOf = (reply: Reply) =>
  setCookies(reply)
    .find((c) => c.startsWith("wx_session="))
    ?.split(";")[0];

async function connectionOf(email: string) {
  const [row] = await ctx.db
    .select()
    .from(schema.driveConnections)
    .where(eq(schema.driveConnections.userId, await ctx.userId(email)));
  return row;
}

async function refreshTokenOf(email: string): Promise<string> {
  const connection = await connectionOf(email);
  return decryptToken(ctx.config.tokenKeys, connection?.credentials ?? "", await ctx.userId(email))
    .token;
}

describe("GET /api/auth/google/login", () => {
  test("Google の認可エンドポイントへ送る(PKCE・state・offline・drive.file の4範囲)", async () => {
    const { url, state } = await startLogin();
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const p = url.searchParams;
    expect(p.get("client_id")).toBe(CLIENT_ID);
    expect(p.get("redirect_uri")).toBe("http://localhost:5173/api/auth/google/callback");
    expect(p.get("response_type")).toBe("code");
    expect(p.get("scope")).toBe(ALL_SCOPES);
    expect(p.get("access_type")).toBe("offline");
    expect(p.get("include_granted_scopes")).toBe("true");
    expect(p.get("prompt")).toBe("select_account");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("code_challenge")).toBeTruthy();
    expect(state?.length).toBeGreaterThan(20);
  });

  test("consent=1 のときは consent も求める", async () => {
    const { url } = await startLogin("?consent=1");
    expect(url.searchParams.get("prompt")).toBe("consent select_account");
  });

  test("一時 Cookie 3つ: HttpOnly・SameSite=Lax・Path=/api/auth・10分。state は URL と同じ", async () => {
    const { reply, state } = await startLogin("?returnTo=/projects/1%3Fq%3Dx&locale=en");
    const cookies = setCookies(reply);
    expect(cookies).toHaveLength(3);
    for (const name of ["wx_oauth_state", "wx_oauth_verifier", "wx_oauth_ctx"]) {
      const cookie = cookies.find((c) => c.startsWith(`${name}=`)) as string;
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Lax");
      expect(cookie).toContain("Path=/api/auth");
      expect(cookie).toContain("Max-Age=600");
    }
    expect(cookies.find((c) => c.startsWith("wx_oauth_state="))).toContain(`=${state};`);
    const ctxCookie = cookies.find((c) => c.startsWith("wx_oauth_ctx=")) as string;
    expect(
      JSON.parse(decodeURIComponent(ctxCookie.split(";")[0]?.split("=")[1] as string)),
    ).toEqual({
      mode: "login",
      returnTo: "/projects/1?q=x",
      locale: "en",
      consent: false,
    });
  });

  test("返す先として受け付けない returnTo は / にし、知らない locale は無視する", async () => {
    for (const bad of ["//evil.example.com", "https://evil.example.com", "/\\evil.example.com"]) {
      const { reply } = await startLogin(`?returnTo=${encodeURIComponent(bad)}&locale=fr`);
      const raw = setCookies(reply).find((c) => c.startsWith("wx_oauth_ctx=")) as string;
      const parsed = JSON.parse(decodeURIComponent(raw.split(";")[0]?.split("=")[1] as string));
      expect(parsed.returnTo).toBe("/");
      expect(parsed.locale).toBeNull();
    }
  });

  test("OAuth クライアントが設定されていないときは /login へ failed を伝える", async () => {
    const bare = createTestContext();
    const reply = await bare.call("GET", "/api/auth/google/login");
    expect(reply.status).toBe(302);
    expect(reply.headers.get("location")).toBe("/login");
    expect(notice(reply, "wx_login_notice")).toEqual({ code: "failed" });
    await bare.close();
  });
});

describe("GET /api/auth/google/callback(ログイン)", () => {
  test("初回: メールで利用者を見つけ、Google の ID・表示名・画像・言語を保存し、連携中にしてセッションを作る", async () => {
    respondWith({});
    const { cookie, state } = await startLogin("?returnTo=/projects/1&locale=en");
    const reply = await callback(cookie, { code: "auth-code", state: state as string });
    expect(reply.status).toBe(302);
    expect(reply.headers.get("location")).toBe("/projects/1");
    expect(sessionOf(reply)).toBeTruthy();
    // 一時 Cookie は使い終わったら消す
    for (const name of ["wx_oauth_state", "wx_oauth_verifier", "wx_oauth_ctx"]) {
      expect(setCookies(reply).find((c) => c.startsWith(`${name}=;`))).toContain("Max-Age=0");
    }

    const [user] = await ctx.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, USERS.newcomer));
    expect(user).toMatchObject({
      googleSubject: "google-sub-new",
      displayName: "新田 太郎",
      avatarUrl: "https://lh3.googleusercontent.com/a/new",
      locale: "en",
    });
    expect(user?.lastLoginAt).toBeInstanceOf(Date);

    const connection = await connectionOf(USERS.newcomer);
    expect(connection?.status).toBe("active");
    expect(connection?.grantedScopes).toContain(DRIVE_SCOPE);
    expect(connection?.credentials).not.toContain("refresh-new");
    expect(await refreshTokenOf(USERS.newcomer)).toBe("1//refresh-new");

    const me = await ctx.call("GET", "/api/me", { cookie: sessionOf(reply) });
    expect(me.json.user.email).toBe(USERS.newcomer);
    expect(me.json.drive.status).toBe("active");

    // PKCE の verifier を送り、クライアントの秘密を使う
    expect(tokenRequests[0]?.get("code")).toBe("auth-code");
    expect(tokenRequests[0]?.get("code_verifier")?.length).toBeGreaterThan(40);
    const success = ctx.logs.find((l) => l.event === "login_succeeded");
    expect(success?.userId).toBe(user?.id);
    expect(JSON.stringify(ctx.logs)).not.toContain(USERS.newcomer);
    expect(JSON.stringify(ctx.logs)).not.toContain("refresh-new");
  });

  test("2回目以降は Google の ID で照合する(メールが変わっても同じ利用者)。言語は上書きしない", async () => {
    respondWith({ claims: { sub: "demo-yamada", email: "renamed@example.com", name: "山田 新" } });
    const { cookie, state } = await startLogin("?locale=en");
    const reply = await callback(cookie, { code: "c", state: state as string });
    expect(reply.headers.get("location")).toBe("/");
    await ctx.db
      .update(schema.users)
      .set({ locale: "ja" })
      .where(eq(schema.users.email, USERS.yamada));
    const { cookie: cookie2, state: state2 } = await startLogin("?locale=en");
    await callback(cookie2, { code: "c", state: state2 as string });
    const [user] = await ctx.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, USERS.yamada));
    expect(user?.displayName).toBe("山田 新");
    expect(user?.locale).not.toBe("en");
    const me = await ctx.call("GET", "/api/me", { cookie: sessionOf(reply) });
    expect(me.json.user.email).toBe(USERS.yamada);
  });

  test("2回目以降の認可情報を新しくする。要再連携だった人は連携中に戻る", async () => {
    respondWith({
      claims: { sub: "demo-tanaka", email: USERS.tanaka },
      refreshToken: "1//tanaka-new",
    });
    const { cookie, state } = await startLogin();
    const reply = await callback(cookie, { code: "c", state: state as string });
    expect(sessionOf(reply)).toBeTruthy();
    const connection = await connectionOf(USERS.tanaka);
    expect(connection?.status).toBe("active");
    expect(await refreshTokenOf(USERS.tanaka)).toBe("1//tanaka-new");
  });

  test("許可されていないアカウント: /login へ not_allowed とメールを伝え、セッションを作らない", async () => {
    respondWith({ claims: { sub: "other", email: "Stranger@Example.com" } });
    const { cookie, state } = await startLogin();
    const reply = await callback(cookie, { code: "c", state: state as string });
    expect(reply.headers.get("location")).toBe("/login");
    expect(notice(reply, "wx_login_notice")).toEqual({
      code: "not_allowed",
      email: "stranger@example.com",
    });
    expect(sessionOf(reply)).toBeUndefined();
    expect(await ctx.db.select().from(schema.sessions)).toHaveLength(0);
    expect(ctx.logs.find((l) => l.event === "login_failed")?.code).toBe("not_allowed");
    expect(JSON.stringify(ctx.logs)).not.toContain("stranger");
  });

  test("別の Google アカウントがすでに結び付いた利用者のメールでは入れない", async () => {
    respondWith({ claims: { sub: "someone-else", email: USERS.yamada } });
    const { cookie, state } = await startLogin();
    const reply = await callback(cookie, { code: "c", state: state as string });
    expect(notice(reply, "wx_login_notice")?.code).toBe("not_allowed");
  });

  test("停止されたアカウント → suspended。判定の順は not_allowed → suspended → drive_scope_missing", async () => {
    respondWith({ claims: { sub: "demo-suzuki", email: USERS.suzuki }, scope: "openid email" });
    const { cookie, state } = await startLogin();
    const reply = await callback(cookie, { code: "c", state: state as string });
    expect(notice(reply, "wx_login_notice")).toEqual({ code: "suspended" });
    expect(sessionOf(reply)).toBeUndefined();
  });

  test("drive.file が許可されていない → drive_scope_missing。何も保存しない", async () => {
    for (const scope of ["openid email profile", undefined]) {
      respondWith({ scope: scope ?? "" });
      const { cookie, state } = await startLogin();
      const reply = await callback(cookie, { code: "c", state: state as string });
      expect(notice(reply, "wx_login_notice")).toEqual({ code: "drive_scope_missing" });
    }
    const [user] = await ctx.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, USERS.newcomer));
    expect(user?.googleSubject).toBeNull();
    expect(await connectionOf(USERS.newcomer)).toBeUndefined();
  });

  test("リフレッシュトークンが返らず連携が無い → consent=1 で login へ送り直す。送り直しても返らなければ failed", async () => {
    respondWith({ refreshToken: null });
    const first = await startLogin("?returnTo=/projects/1&locale=ja");
    const retry = await callback(first.cookie, { code: "c", state: first.state as string });
    expect(retry.status).toBe(302);
    const location = new URL(retry.headers.get("location") as string, "http://localhost");
    expect(location.pathname).toBe("/api/auth/google/login");
    expect(location.searchParams.get("consent")).toBe("1");
    expect(location.searchParams.get("returnTo")).toBe("/projects/1");
    expect(location.searchParams.get("locale")).toBe("ja");
    expect(sessionOf(retry)).toBeUndefined();

    const second = await startLogin("?consent=1");
    const failed = await callback(second.cookie, { code: "c", state: second.state as string });
    expect(failed.headers.get("location")).toBe("/login");
    expect(notice(failed, "wx_login_notice")).toEqual({ code: "failed" });
  });

  test("リフレッシュトークンが返らなくても、連携中の人は入れる(トークンは変えない)", async () => {
    const before = await connectionOf(USERS.sato);
    respondWith({ claims: { sub: "demo-sato", email: USERS.sato }, refreshToken: null });
    const { cookie, state } = await startLogin();
    const reply = await callback(cookie, { code: "c", state: state as string });
    expect(reply.headers.get("location")).toBe("/");
    expect(sessionOf(reply)).toBeTruthy();
    expect((await connectionOf(USERS.sato))?.credentials).toBe(before?.credentials);
  });

  test("拒否・取り消し: error=access_denied は cancelled、ほかの error は failed", async () => {
    for (const [error, code] of [
      ["access_denied", "cancelled"],
      ["server_error", "failed"],
    ] as const) {
      const { cookie, state } = await startLogin();
      const reply = await callback(cookie, { error, state: state as string });
      expect(reply.headers.get("location")).toBe("/login");
      expect(notice(reply, "wx_login_notice")).toEqual({ code });
      expect(tokenRequests).toHaveLength(0);
    }
  });

  test("state が違う・Cookie が無い・code が無い → failed。Google を呼ばない", async () => {
    const { cookie, state } = await startLogin();
    const cases = [
      await callback(cookie, { code: "c", state: "forged" }),
      await callback("", { code: "c", state: state as string }),
      await callback(cookie, { state: state as string }),
      await ctx.call("GET", "/api/auth/google/callback"),
    ];
    for (const reply of cases) {
      expect(reply.headers.get("location")).toBe("/login");
      expect(notice(reply, "wx_login_notice")).toEqual({ code: "failed" });
    }
    expect(tokenRequests).toHaveLength(0);
  });

  test("コードの交換に失敗した・ID トークンが確認できない → failed", async () => {
    tokenResponse = () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    const a = await startLogin();
    const exchange = await callback(a.cookie, { code: "c", state: a.state as string });
    expect(notice(exchange, "wx_login_notice")).toEqual({ code: "failed" });

    for (const claims of [
      { aud: "someone-else" },
      { iss: "https://evil.example.com" },
      { exp: 1 },
      { email_verified: false },
    ]) {
      respondWith({ claims });
      const b = await startLogin();
      const reply = await callback(b.cookie, { code: "c", state: b.state as string });
      expect(notice(reply, "wx_login_notice")).toEqual({ code: "failed" });
      expect(sessionOf(reply)).toBeUndefined();
    }
    expect(
      ctx.logs.filter((l) => l.event === "login_failed").every((l) => l.code === "failed"),
    ).toBe(true);
  });

  test("ログイン画面を経由せず callback へ来た再連携用の Cookie は、セッションが無ければ failed", async () => {
    // wx_oauth_ctx の mode が reconnect でも、セッションが無い人には何も保存しない
    respondWith({ claims: { sub: "demo-tanaka", email: USERS.tanaka } });
    const tanaka = await ctx.login(USERS.tanaka);
    const { cookie, state } = await (async () => {
      const r = await ctx.call("GET", "/api/auth/google/reconnect", { cookie: tanaka });
      return {
        cookie: cookieHeader(r.headers),
        state: new URL(r.headers.get("location") as string).searchParams.get("state"),
      };
    })();
    const reply = await callback(cookie, { code: "c", state: state as string });
    expect(notice(reply, "wx_drive_notice")).toEqual({ code: "failed" });
    expect((await connectionOf(USERS.tanaka))?.status).toBe("needs_reauth");
  });
});

describe("GET /api/auth/google/reconnect", () => {
  async function startReconnect(email: string, query = "") {
    const session = await ctx.login(email);
    const reply = await ctx.call("GET", `/api/auth/google/reconnect${query}`, { cookie: session });
    return { session, reply, cookie: cookieHeader(reply.headers) };
  }

  test("認証が要る", async () => {
    const reply = await ctx.call("GET", "/api/auth/google/reconnect");
    expect(reply.status).toBe(401);
    expect(reply.json.error.code).toBe("UNAUTHENTICATED");
  });

  test("DRIVE_MODE=google: prompt=consent と login_hint を付けて同意画面へ送る", async () => {
    const session = await ctx.login(USERS.tanaka);
    const reply = await ctx.call("GET", "/api/auth/google/reconnect?returnTo=/projects/9", {
      cookie: session,
    });
    const url = new URL(reply.headers.get("location") as string);
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("login_hint")).toBe(USERS.tanaka);
    expect(url.searchParams.get("access_type")).toBe("offline");
    const raw = setCookies(reply).find((c) => c.startsWith("wx_oauth_ctx=")) as string;
    expect(
      JSON.parse(decodeURIComponent(raw.split(";")[0]?.split("=")[1] as string)),
    ).toMatchObject({
      mode: "reconnect",
      returnTo: "/projects/9",
    });
  });

  test("許可された: 連携中に戻し、wx_drive_notice(reconnected)を付けて returnTo へ戻る", async () => {
    respondWith({ claims: { sub: "demo-tanaka", email: USERS.tanaka }, refreshToken: "1//re" });
    const { session, reply, cookie } = await startReconnect(USERS.tanaka, "?returnTo=/projects/9");
    const state = new URL(reply.headers.get("location") as string).searchParams.get("state");
    const back = await callback(cookie, { code: "c", state: state as string }, session);
    expect(back.headers.get("location")).toBe("/projects/9");
    expect(notice(back, "wx_drive_notice")).toEqual({ code: "reconnected" });
    const connection = await connectionOf(USERS.tanaka);
    expect(connection?.status).toBe("active");
    expect(await refreshTokenOf(USERS.tanaka)).toBe("1//re");
    // セッションは作り直さない
    expect(sessionOf(back)).toBeUndefined();
  });

  test("結果ごとの通知: cancelled・failed・wrong_account・scope_missing。連携は要再連携のまま", async () => {
    const cases: [string, () => Promise<Reply>][] = [];
    const run = async (
      code: string,
      claims: Record<string, unknown>,
      extra: Parameters<typeof respondWith>[0],
    ) => {
      respondWith({ claims: { sub: "demo-tanaka", email: USERS.tanaka, ...claims }, ...extra });
      const { session, reply, cookie } = await startReconnect(USERS.tanaka);
      const state = new URL(reply.headers.get("location") as string).searchParams.get("state");
      const back = await callback(cookie, { code: "c", state: state as string }, session);
      expect(notice(back, "wx_drive_notice")).toEqual({ code });
      expect(back.headers.get("location")).toBe("/");
      expect((await connectionOf(USERS.tanaka))?.status).toBe("needs_reauth");
    };
    expect(cases).toHaveLength(0);
    await run("wrong_account", { sub: "demo-sato" }, {});
    expect(ctx.logs.find((l) => l.event === "reconnect_failed")).toMatchObject({
      severity: "WARN",
      code: "wrong_account",
    });
    await run("scope_missing", {}, { scope: "openid email profile" });
    await run("failed", {}, { refreshToken: null });
    await run("failed", { aud: "someone-else" }, {});

    const { session, reply, cookie } = await startReconnect(USERS.tanaka);
    const state = new URL(reply.headers.get("location") as string).searchParams.get("state");
    const cancelled = await callback(
      cookie,
      { error: "access_denied", state: state as string },
      session,
    );
    expect(notice(cancelled, "wx_drive_notice")).toEqual({ code: "cancelled" });
    expect(cancelled.headers.get("location")).toBe("/");
    expect((await connectionOf(USERS.tanaka))?.status).toBe("needs_reauth");
  });

  test("DRIVE_MODE=mock: Google へ行かずに連携中へ戻し、wx_drive_notice(reconnected)で returnTo へ戻る", async () => {
    const mock = createTestContext();
    await mock.seed();
    const session = await mock.login(USERS.tanaka);
    const reply = await mock.call("GET", "/api/auth/google/reconnect?returnTo=/projects/9", {
      cookie: session,
    });
    expect(reply.status).toBe(302);
    expect(reply.headers.get("location")).toBe("/projects/9");
    expect(notice(reply, "wx_drive_notice")).toEqual({ code: "reconnected" });
    expect((await connectionOf(USERS.tanaka))?.status).toBe("active");
    const me = await mock.call("GET", "/api/me", { cookie: session });
    expect(me.json.drive.status).toBe("active");
    await mock.close();
  });

  test("DRIVE_MODE=mock でも、受け付けない returnTo は / にする", async () => {
    const mock = createTestContext();
    const session = await mock.login(USERS.tanaka);
    const reply = await mock.call("GET", "/api/auth/google/reconnect?returnTo=//evil.example.com", {
      cookie: session,
    });
    expect(reply.headers.get("location")).toBe("/");
    await mock.close();
  });
});
