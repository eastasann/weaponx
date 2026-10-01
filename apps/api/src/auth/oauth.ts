import { decodeIdToken, Google } from "arctic";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import * as t from "../db/schema";
import type { Config } from "../lib/config";
import { encryptToken } from "./token-crypto";

export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
/** 求める範囲は4つだけ(ADR-011) */
export const OAUTH_SCOPES = ["openid", "email", "profile", DRIVE_FILE_SCOPE];

export const OAUTH_STATE_COOKIE = "wx_oauth_state";
export const OAUTH_VERIFIER_COOKIE = "wx_oauth_verifier";
export const OAUTH_CTX_COOKIE = "wx_oauth_ctx";
export const OAUTH_COOKIE_PATH = "/api/auth";
export const OAUTH_COOKIE_MAX_AGE_S = 10 * 60;

export type OAuthContext = {
  mode: "login" | "reconnect";
  returnTo: string;
  locale: "ja" | "en" | null;
  consent: boolean;
};

export function callbackUri(config: Pick<Config, "appOrigin">): string {
  return `${config.appOrigin}/api/auth/google/callback`;
}

export function createGoogleClient(
  config: Pick<Config, "appOrigin"> & { google: NonNullable<Config["google"]> },
): Google {
  return new Google(config.google.clientId, config.google.clientSecret, callbackUri(config));
}

/** `wx_oauth_ctx` の値。壊れた・形式の違う値は `null`(認証の失敗として扱う) */
export function parseContext(raw: string | undefined): OAuthContext | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(decodeURIComponent(raw)) as Record<string, unknown>;
    if (
      (value.mode !== "login" && value.mode !== "reconnect") ||
      typeof value.returnTo !== "string" ||
      (value.locale !== null && value.locale !== "ja" && value.locale !== "en") ||
      typeof value.consent !== "boolean"
    ) {
      return null;
    }
    return value as OAuthContext;
  } catch {
    return null;
  }
}

export const serializeContext = (ctx: OAuthContext): string =>
  encodeURIComponent(JSON.stringify(ctx));

export type IdentityClaims = {
  sub: string;
  email: string;
  name: string | null;
  picture: string | null;
};

const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

/**
 * ID トークンのクレームを確かめる(02-01 7章「OAuth」)。トークンエンドポイントから TLS で直接受け取った
 * ものなので、署名は検証せず、`aud`・`iss`・`exp`・`email_verified` を見る。確認できなければ `null`。
 */
export function readIdentity(
  idToken: string,
  clientId: string,
  nowMs: number = Date.now(),
): IdentityClaims | null {
  let claims: Record<string, unknown>;
  try {
    claims = decodeIdToken(idToken) as Record<string, unknown>;
  } catch {
    return null;
  }
  const { sub, email, name, picture, aud, iss, exp, email_verified: verified } = claims;
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (
    typeof sub !== "string" ||
    !sub ||
    typeof email !== "string" ||
    !email ||
    !audiences.includes(clientId) ||
    typeof iss !== "string" ||
    !ISSUERS.has(iss) ||
    typeof exp !== "number" ||
    exp * 1000 <= nowMs ||
    (verified !== true && verified !== "true")
  ) {
    return null;
  }
  return {
    sub,
    email: email.trim().toLowerCase(),
    name: typeof name === "string" && name.trim() ? name.trim().slice(0, 200) : null,
    // 画像の URL は画面の <img> に使うので、https のものだけを保存する
    picture: typeof picture === "string" && picture.startsWith("https://") ? picture : null,
  };
}

/**
 * 認可情報を保存する。リフレッシュトークンがあれば暗号化して連携中で作る・更新し、
 * 無ければ許可の範囲と日時だけを更新する(その人の連携の行が既にあるとき)。
 */
export async function saveDriveConnection(
  db: Pick<Db, "insert" | "update">,
  keys: Config["tokenKeys"],
  userId: string,
  grant: { refreshToken: string | null; scopes: string[] },
): Promise<void> {
  const now = new Date();
  if (grant.refreshToken === null) {
    await db
      .update(t.driveConnections)
      .set({ grantedScopes: grant.scopes, connectedAt: now })
      .where(eq(t.driveConnections.userId, userId));
    return;
  }
  const values = {
    status: "active" as const,
    credentials: encryptToken(keys, grant.refreshToken, userId),
    grantedScopes: grant.scopes,
    connectedAt: now,
  };
  await db
    .insert(t.driveConnections)
    .values({ userId, ...values })
    .onConflictDoUpdate({ target: t.driveConnections.userId, set: values });
}
