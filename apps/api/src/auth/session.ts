import { createHash, randomBytes } from "node:crypto";
import { eq, lt } from "drizzle-orm";
import { Elysia } from "elysia";
import * as t from "../db/schema";
import { appendSetCookie, clearCookie, readCookie, serializeCookie } from "../lib/cookies";
import type { AppDeps } from "../lib/deps";
import { AppError } from "../lib/errors";
import { requestState } from "../lib/http";

export const SESSION_COOKIE = "wx_session";
export const LOGIN_NOTICE_COOKIE = "wx_login_notice";
export const DRIVE_NOTICE_COOKIE = "wx_drive_notice";

const DAY_MS = 24 * 60 * 60 * 1000;
/** 最後の操作から14日。残りが7日を切ったら延長する(ADR-010) */
const SESSION_TTL_MS = 14 * DAY_MS;
const EXTEND_BELOW_MS = 7 * DAY_MS;
const NOTICE_MAX_AGE_S = 60;

export type AuthUser = {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  globalRole: "member" | "admin";
  locale: "ja" | "en" | null;
};

export type Auth = { user: AuthUser };

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

function sessionCookie(deps: AppDeps, token: string, maxAgeMs: number): string {
  return serializeCookie(SESSION_COOKIE, token, {
    maxAge: Math.floor(maxAgeMs / 1000),
    httpOnly: true,
    secure: deps.config.secureCookies,
  });
}

export function clearSessionCookie(deps: AppDeps): string {
  return clearCookie(SESSION_COOKIE, { httpOnly: true, secure: deps.config.secureCookies });
}

/**
 * ログイン画面に理由を伝える Cookie(02-01 5.2)。画面の JS が読んで消す。
 * 値は JSON を `encodeURIComponent` したもの。
 */
export function loginNoticeCookie(deps: AppDeps, notice: { code: string; email?: string }): string {
  return noticeCookie(deps, LOGIN_NOTICE_COOKIE, notice);
}

/** 再連携の結果を画面に伝える Cookie(02-01 5.2)。`loginNoticeCookie` と同じ形式 */
export function driveNoticeCookie(deps: AppDeps, notice: { code: string }): string {
  return noticeCookie(deps, DRIVE_NOTICE_COOKIE, notice);
}

function noticeCookie(deps: AppDeps, name: string, notice: object): string {
  return serializeCookie(name, encodeURIComponent(JSON.stringify(notice)), {
    maxAge: NOTICE_MAX_AGE_S,
    httpOnly: false,
    secure: deps.config.secureCookies,
  });
}

/**
 * セッションを作り、`wx_session` の Set-Cookie を返す。期限切れの行はここでまとめて消す(02-01 6章)。
 * DB にはトークンの SHA-256 だけを置く。
 */
export async function createSession(deps: AppDeps, userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  await deps.db.transaction(async (tx) => {
    await tx.delete(t.sessions).where(lt(t.sessions.expiresAt, now));
    await tx.insert(t.sessions).values({
      id: hashToken(token),
      userId,
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
      createdAt: now,
      lastUsedAt: now,
    });
  });
  return sessionCookie(deps, token, SESSION_TTL_MS);
}

export async function deleteSession(deps: AppDeps, request: Request): Promise<void> {
  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (token) await deps.db.delete(t.sessions).where(eq(t.sessions.id, hashToken(token)));
}

type Resolved =
  | { kind: "none" }
  | { kind: "suspended"; sessionId: string }
  | { kind: "ok"; user: AuthUser; sessionId: string; expiresAt: Date };

async function resolveSession(deps: AppDeps, request: Request): Promise<Resolved> {
  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (!token) return { kind: "none" };
  const sessionId = hashToken(token);
  const [row] = await deps.db
    .select({
      expiresAt: t.sessions.expiresAt,
      id: t.users.id,
      email: t.users.email,
      displayName: t.users.displayName,
      avatarUrl: t.users.avatarUrl,
      globalRole: t.users.globalRole,
      locale: t.users.locale,
      status: t.users.status,
    })
    .from(t.sessions)
    .innerJoin(t.users, eq(t.users.id, t.sessions.userId))
    .where(eq(t.sessions.id, sessionId))
    .limit(1);
  if (!row || row.expiresAt.getTime() <= Date.now()) return { kind: "none" };
  if (row.status === "suspended") return { kind: "suspended", sessionId };
  const { expiresAt, status: _status, ...user } = row;
  return { kind: "ok", user, sessionId, expiresAt };
}

/**
 * Cookie のセッションから利用者を決める。無い・期限切れは `UNAUTHENTICATED`。
 * 停止中の利用者は、このときにセッションを消して `ACCOUNT_SUSPENDED` にする(02-01 7章)。
 * 延長するときは新しい Set-Cookie を `set` に足す。
 */
export async function authenticate(
  deps: AppDeps,
  request: Request,
  set: { headers: Record<string, unknown> },
): Promise<Auth> {
  const resolved = await resolveSession(deps, request);
  if (resolved.kind === "none") throw new AppError("UNAUTHENTICATED");
  if (resolved.kind === "suspended") {
    await deps.db.delete(t.sessions).where(eq(t.sessions.id, resolved.sessionId));
    throw new AppError("ACCOUNT_SUSPENDED", {
      cookies: [clearSessionCookie(deps), loginNoticeCookie(deps, { code: "suspended" })],
    });
  }
  requestState(request).userId = resolved.user.id;

  const now = Date.now();
  if (resolved.expiresAt.getTime() - now < EXTEND_BELOW_MS) {
    // 毎回書くと読み取りのたびに更新が走るので、`last_used_at` は延長するときだけ進める
    const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE) as string;
    await deps.db
      .update(t.sessions)
      .set({ expiresAt: new Date(now + SESSION_TTL_MS), lastUsedAt: new Date(now) })
      .where(eq(t.sessions.id, resolved.sessionId));
    appendSetCookie(set, sessionCookie(deps, token, SESSION_TTL_MS));
  }
  return { user: resolved.user };
}

/** セッションがあれば利用者 ID を返す。無くても・停止中でも失敗にしない(`POST /api/client-errors` 用) */
export async function optionalUserId(deps: AppDeps, request: Request): Promise<string | undefined> {
  const resolved = await resolveSession(deps, request);
  return resolved.kind === "ok" ? resolved.user.id : undefined;
}

/** 認証の要るルートの共通ガード。登録したプラグインの中のルートに `auth` を渡す */
export function authenticated(deps: AppDeps) {
  return new Elysia().derive({ as: "scoped" }, async ({ request, set }) => ({
    auth: await authenticate(deps, request, set),
  }));
}

/** 管理者だけのルートのガード。入力の検証より先に 403 `ADMIN_REQUIRED` を返す */
export function adminAuthenticated(deps: AppDeps) {
  return authenticated(deps).derive({ as: "scoped" }, ({ auth }) => {
    if (auth.user.globalRole !== "admin") throw new AppError("ADMIN_REQUIRED");
    return {};
  });
}
