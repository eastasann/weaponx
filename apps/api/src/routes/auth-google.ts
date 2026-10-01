import { safeReturnTo } from "@weaponx/shared";
import { generateCodeVerifier, generateState } from "arctic";
import { and, eq, isNull, or } from "drizzle-orm";
import { Elysia, t } from "elysia";
import {
  createGoogleClient,
  DRIVE_FILE_SCOPE,
  OAUTH_COOKIE_MAX_AGE_S,
  OAUTH_COOKIE_PATH,
  OAUTH_CTX_COOKIE,
  OAUTH_SCOPES,
  OAUTH_STATE_COOKIE,
  OAUTH_VERIFIER_COOKIE,
  type OAuthContext,
  parseContext,
  readIdentity,
  saveDriveConnection,
  serializeContext,
} from "../auth/oauth";
import {
  authenticated,
  createSession,
  driveNoticeCookie,
  loginNoticeCookie,
  optionalUserId,
} from "../auth/session";
import * as schema from "../db/schema";
import { appendSetCookie, clearCookie, readCookie, serializeCookie } from "../lib/cookies";
import type { AppDeps } from "../lib/deps";
import { requestState, safeStack } from "../lib/http";

type LoginFailure = "not_allowed" | "suspended" | "drive_scope_missing" | "cancelled" | "failed";
type ReconnectResult = "reconnected" | "wrong_account" | "scope_missing" | "cancelled" | "failed";

const locales = new Set(["ja", "en"]);

/** Google へ送るときに付ける `state`・PKCE・文脈の Cookie(02-01 5.2) */
function oauthCookies(deps: AppDeps, state: string, verifier: string, ctx: OAuthContext): string[] {
  const options = {
    maxAge: OAUTH_COOKIE_MAX_AGE_S,
    httpOnly: true,
    secure: deps.config.secureCookies,
    path: OAUTH_COOKIE_PATH,
  };
  return [
    serializeCookie(OAUTH_STATE_COOKIE, state, options),
    serializeCookie(OAUTH_VERIFIER_COOKIE, verifier, options),
    serializeCookie(OAUTH_CTX_COOKIE, serializeContext(ctx), options),
  ];
}

function clearOauthCookies(deps: AppDeps): string[] {
  const options = {
    httpOnly: true,
    secure: deps.config.secureCookies,
    path: OAUTH_COOKIE_PATH,
  };
  return [OAUTH_STATE_COOKIE, OAUTH_VERIFIER_COOKIE, OAUTH_CTX_COOKIE].map((name) =>
    clearCookie(name, options),
  );
}

type SetContext = { status?: number | string; headers: Record<string, unknown> };

function redirect(set: SetContext, location: string, cookies: string[] = []): string {
  set.status = 302;
  set.headers.location = location;
  for (const cookie of cookies) appendSetCookie(set, cookie);
  return "";
}

/**
 * ログイン(`mode: "login"`)と再連携(`mode: "reconnect"`)の同意画面への送り先を作る。
 * `prompt=consent` は、リフレッシュトークンを必ず返させるために使う。
 */
function authorizationRedirect(
  deps: AppDeps,
  set: SetContext,
  ctx: OAuthContext,
  options: { prompt: string; loginHint?: string },
): string {
  const google = deps.config.google;
  if (!google) throw new Error("Google OAuth is not configured");
  const state = generateState();
  const verifier = generateCodeVerifier();
  const url = createGoogleClient({ ...deps.config, google }).createAuthorizationURL(
    state,
    verifier,
    OAUTH_SCOPES,
  );
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("prompt", options.prompt);
  if (options.loginHint) url.searchParams.set("login_hint", options.loginHint);
  return redirect(set, url.toString(), oauthCookies(deps, state, verifier, ctx));
}

/** Google の OAuth ルート(02-01 5.2) */
export function googleAuthRoutes(deps: AppDeps) {
  const { config, db, logger } = deps;

  function loginFailed(
    set: SetContext,
    request: Request,
    code: LoginFailure,
    email?: string,
  ): string {
    logger.warn("login failed", {
      event: "login_failed",
      requestId: requestState(request).id,
      code,
    });
    return redirect(set, "/login", [
      ...clearOauthCookies(deps),
      loginNoticeCookie(deps, { code, ...(email ? { email } : {}) }),
    ]);
  }

  function reconnectResult(
    set: SetContext,
    request: Request,
    ctx: OAuthContext,
    code: ReconnectResult,
  ): string {
    if (code !== "reconnected") {
      logger.warn("drive reconnect failed", {
        event: "reconnect_failed",
        requestId: requestState(request).id,
        code,
      });
    }
    return redirect(set, ctx.returnTo, [
      ...clearOauthCookies(deps),
      driveNoticeCookie(deps, { code }),
    ]);
  }

  /** ログインの `callback`(02-01 5.2 の手順1〜7) */
  async function completeLogin(
    set: SetContext,
    request: Request,
    ctx: OAuthContext,
    code: string,
    verifier: string,
  ): Promise<string> {
    const google = config.google;
    if (!google) return loginFailed(set, request, "failed");
    let tokens: Awaited<
      ReturnType<ReturnType<typeof createGoogleClient>["validateAuthorizationCode"]>
    >;
    let identity: ReturnType<typeof readIdentity>;
    try {
      tokens = await createGoogleClient({ ...config, google }).validateAuthorizationCode(
        code,
        verifier,
      );
      identity = readIdentity(tokens.idToken(), google.clientId);
    } catch {
      return loginFailed(set, request, "failed");
    }
    if (!identity) return loginFailed(set, request, "failed");

    const columns = {
      id: schema.users.id,
      status: schema.users.status,
      locale: schema.users.locale,
      displayName: schema.users.displayName,
    };
    const [bySubject] = await db
      .select(columns)
      .from(schema.users)
      .where(eq(schema.users.googleSubject, identity.sub));
    const [user] = bySubject
      ? [bySubject]
      : await db
          .select(columns)
          .from(schema.users)
          .where(and(eq(schema.users.email, identity.email), isNull(schema.users.googleSubject)));
    if (!user) return loginFailed(set, request, "not_allowed", identity.email);
    if (user.status === "suspended") return loginFailed(set, request, "suspended");
    const scopes = tokens.hasScopes() ? tokens.scopes() : [];
    if (!scopes.includes(DRIVE_FILE_SCOPE)) {
      return loginFailed(set, request, "drive_scope_missing");
    }

    const refreshToken = tokens.hasRefreshToken() ? tokens.refreshToken() : null;
    if (refreshToken === null) {
      const [connection] = await db
        .select({ status: schema.driveConnections.status })
        .from(schema.driveConnections)
        .where(eq(schema.driveConnections.userId, user.id));
      if (connection?.status !== "active") {
        // 以前の許可が残っていると、同意画面を飛ばされてリフレッシュトークンが返らない。もう一度、同意まで求める
        if (ctx.consent) return loginFailed(set, request, "failed");
        const query = new URLSearchParams({ returnTo: ctx.returnTo, consent: "1" });
        if (ctx.locale) query.set("locale", ctx.locale);
        return redirect(set, `/api/auth/google/login?${query}`, clearOauthCookies(deps));
      }
    }

    let sessionCookie: string;
    try {
      await db.transaction(async (tx) => {
        const updated = await tx
          .update(schema.users)
          .set({
            googleSubject: identity.sub,
            displayName: identity.name ?? user.displayName,
            avatarUrl: identity.picture,
            lastLoginAt: new Date(),
            locale: user.locale ?? ctx.locale,
          })
          .where(
            and(
              eq(schema.users.id, user.id),
              or(isNull(schema.users.googleSubject), eq(schema.users.googleSubject, identity.sub)),
            ),
          )
          .returning({ id: schema.users.id });
        // 照合から更新までの間に、別の Google アカウントが同じ利用者に結び付いた
        if (updated.length === 0) throw new Error("google_subject conflict");
        await saveDriveConnection(tx, config.tokenKeys, user.id, { refreshToken, scopes });
      });
      sessionCookie = await createSession(deps, user.id);
    } catch (error) {
      logger.error("login could not be saved", {
        event: "unhandled_error",
        requestId: requestState(request).id,
        userId: user.id,
        stack_trace: safeStack(error),
      });
      return loginFailed(set, request, "failed");
    }
    logger.info("login succeeded", {
      event: "login_succeeded",
      requestId: requestState(request).id,
      userId: user.id,
    });
    return redirect(set, ctx.returnTo, [...clearOauthCookies(deps), sessionCookie]);
  }

  /** 再連携の `callback`(`mode: "reconnect"`) */
  async function completeReconnect(
    set: SetContext,
    request: Request,
    ctx: OAuthContext,
    code: string,
    verifier: string,
  ): Promise<string> {
    const google = config.google;
    const userId = await optionalUserId(deps, request);
    if (!google || !userId) return reconnectResult(set, request, ctx, "failed");
    const [user] = await db
      .select({ googleSubject: schema.users.googleSubject })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    let tokens: Awaited<
      ReturnType<ReturnType<typeof createGoogleClient>["validateAuthorizationCode"]>
    >;
    let identity: ReturnType<typeof readIdentity>;
    try {
      tokens = await createGoogleClient({ ...config, google }).validateAuthorizationCode(
        code,
        verifier,
      );
      identity = readIdentity(tokens.idToken(), google.clientId);
    } catch {
      return reconnectResult(set, request, ctx, "failed");
    }
    if (!identity || !user) return reconnectResult(set, request, ctx, "failed");
    if (identity.sub !== user.googleSubject) {
      return reconnectResult(set, request, ctx, "wrong_account");
    }
    const scopes = tokens.hasScopes() ? tokens.scopes() : [];
    if (!scopes.includes(DRIVE_FILE_SCOPE)) {
      return reconnectResult(set, request, ctx, "scope_missing");
    }
    // 再連携は `prompt=consent` で送っているので、リフレッシュトークンが返らないのは想定外の失敗
    if (!tokens.hasRefreshToken()) return reconnectResult(set, request, ctx, "failed");
    try {
      await saveDriveConnection(db, config.tokenKeys, userId, {
        refreshToken: tokens.refreshToken(),
        scopes,
      });
    } catch (error) {
      logger.error("reconnect could not be saved", {
        event: "unhandled_error",
        requestId: requestState(request).id,
        userId,
        stack_trace: safeStack(error),
      });
      return reconnectResult(set, request, ctx, "failed");
    }
    return reconnectResult(set, request, ctx, "reconnected");
  }

  return new Elysia({ prefix: "/auth/google" })
    .get(
      "/login",
      ({ query, set, request }) => {
        if (!config.google) return loginFailed(set, request, "failed");
        const locale = query.locale && locales.has(query.locale) ? query.locale : null;
        return authorizationRedirect(
          deps,
          set,
          {
            mode: "login",
            returnTo: safeReturnTo(query.returnTo),
            locale: locale as OAuthContext["locale"],
            consent: query.consent === "1",
          },
          { prompt: query.consent === "1" ? "consent select_account" : "select_account" },
        );
      },
      {
        query: t.Object({
          returnTo: t.Optional(t.String()),
          locale: t.Optional(t.String()),
          consent: t.Optional(t.String()),
        }),
      },
    )
    .get(
      "/callback",
      async ({ query, set, request }) => {
        const cookieHeader = request.headers.get("cookie");
        const ctx = parseContext(readCookie(cookieHeader, OAUTH_CTX_COOKIE));
        const state = readCookie(cookieHeader, OAUTH_STATE_COOKIE);
        const verifier = readCookie(cookieHeader, OAUTH_VERIFIER_COOKIE);
        // 文脈が読めないときは、どちらの操作か分からないのでログインの失敗にする
        const context: OAuthContext = ctx
          ? { ...ctx, returnTo: safeReturnTo(ctx.returnTo) }
          : { mode: "login", returnTo: "/", locale: null, consent: false };
        const fail = (code: "failed" | "cancelled") =>
          context.mode === "reconnect"
            ? reconnectResult(set, request, context, code)
            : loginFailed(set, request, code);

        if (!ctx || !state || !verifier || query.state !== state) return fail("failed");
        if (query.error !== undefined) {
          return fail(query.error === "access_denied" ? "cancelled" : "failed");
        }
        if (!query.code) return fail("failed");
        return context.mode === "reconnect"
          ? completeReconnect(set, request, context, query.code, verifier)
          : completeLogin(set, request, context, query.code, verifier);
      },
      {
        query: t.Object({
          code: t.Optional(t.String()),
          state: t.Optional(t.String()),
          error: t.Optional(t.String()),
        }),
      },
    )
    .use(authenticated(deps))
    .get(
      "/reconnect",
      async ({ auth, query, set, request }) => {
        const returnTo = safeReturnTo(query.returnTo);
        const ctx: OAuthContext = { mode: "reconnect", returnTo, locale: null, consent: true };
        if (config.driveMode === "mock") {
          // ドライブの模擬は Google へ行かずに連携中へ戻す(02-01 5.10)
          const updated = await db
            .update(schema.driveConnections)
            .set({ status: "active", connectedAt: new Date() })
            .where(eq(schema.driveConnections.userId, auth.user.id))
            .returning({ userId: schema.driveConnections.userId });
          return reconnectResult(set, request, ctx, updated.length > 0 ? "reconnected" : "failed");
        }
        return authorizationRedirect(deps, set, ctx, {
          prompt: "consent",
          loginHint: auth.user.email,
        });
      },
      { query: t.Object({ returnTo: t.Optional(t.String()) }) },
    );
}
