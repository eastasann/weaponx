import type { DocumentKind } from "@weaponx/shared";
import { and, eq } from "drizzle-orm";
import { DRIVE_FILE_SCOPE } from "../auth/oauth";
import { decryptToken, encryptToken, TokenDecryptError } from "../auth/token-crypto";
import type { Db } from "../db/client";
import * as t from "../db/schema";
import type { Config } from "../lib/config";
import type { Logger } from "../lib/logger";
import {
  type CreatableKind,
  type Drive,
  DriveError,
  type DriveFile,
  driveFileUrl,
  type PickerToken,
} from "./types";

const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const FILE_FIELDS = "id,name,mimeType,modifiedTime";
/** 1回だけ待って再試行するときの待ち時間(02-01 8章) */
const RETRY_DELAY_MS = 1000;
/** 期限の直前のトークンを使い回さないための余裕 */
const EXPIRY_MARGIN_MS = 60_000;
/** Picker がファイルを選ばせている間に切れないよう、渡すトークンに求める残り時間 */
const PICKER_MIN_REMAINING_MS = 5 * 60_000;

const MIME_KINDS: Record<string, DocumentKind> = {
  "application/vnd.google-apps.document": "google_doc",
  "application/vnd.google-apps.presentation": "google_slides",
  "application/vnd.google-apps.spreadsheet": "google_sheets",
  "application/pdf": "pdf",
};
const CREATE_MIME: Record<CreatableKind, string> = {
  google_doc: "application/vnd.google-apps.document",
  google_slides: "application/vnd.google-apps.presentation",
};

/** 利用者の認可が使えないことを表す Google の理由(認可エラー。design-spec 6.0.5) */
const REAUTH_REASONS = new Set([
  "authError",
  "insufficientPermissions",
  "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
]);
const RATE_LIMIT_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "sharingRateLimitExceeded",
]);
/** アプリ側の設定や容量の問題で、利用者のファイルの権限とは関係ない理由 */
const UNAVAILABLE_REASONS = new Set([
  "accessNotConfigured",
  "SERVICE_DISABLED",
  "dailyLimitExceeded",
  "storageQuotaExceeded",
  "quotaExceeded",
]);

type AccessToken = { accessToken: string; expiresAt: number };

export type GoogleDriveOptions = {
  config: Pick<Config, "tokenKeys" | "google">;
  db: Db;
  logger: Logger;
  /** テストで Google への通信を差し替える */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

/** 2xx なのに本文が JSON でないときは、想定外の応答として `unavailable` にする */
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    throw new DriveError("unavailable", { cause });
  }
}

type Reasons = { reasons: string[] };

/** Google のエラー応答から、`errors[].reason` と `details[].reason` を集める。メッセージは読まない */
async function readReasons(response: Response): Promise<Reasons> {
  try {
    const body = (await response.json()) as {
      error?: { errors?: { reason?: unknown }[]; details?: { reason?: unknown }[] } | string;
    };
    if (typeof body.error === "string") return { reasons: [body.error] };
    const list = [...(body.error?.errors ?? []), ...(body.error?.details ?? [])];
    return {
      reasons: list.map((e) => e.reason).filter((r): r is string => typeof r === "string"),
    };
  } catch {
    return { reasons: [] };
  }
}

/**
 * - `rate_limited`: Google が処理しなかったことが分かる失敗。どの呼び出しも再試行してよい
 * - `server_error`: 処理されたかどうか分からない失敗。重複して作らないよう、作成・コピーは再試行しない
 * - `renew_token`: キャッシュしたアクセストークンが古い(取り消された・範囲が増える前のもの)ことがある認可エラー
 */
type Verdict =
  | "reauth"
  | "renew_token"
  | "not_accessible"
  | "rate_limited"
  | "server_error"
  | "unavailable";

/** Drive API の失敗の分け方(02-01 8章「Drive の応答の分け方」) */
function classify(status: number, { reasons }: Reasons): Verdict {
  if (status === 401) return "renew_token";
  if (status === 403) {
    if (reasons.some((r) => REAUTH_REASONS.has(r))) return "renew_token";
    if (reasons.some((r) => RATE_LIMIT_REASONS.has(r))) return "rate_limited";
    if (reasons.some((r) => UNAVAILABLE_REASONS.has(r))) return "unavailable";
    return "not_accessible";
  }
  if (status === 404) return "not_accessible";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "unavailable";
}

function toFile(body: unknown): DriveFile {
  const { id, name, mimeType, modifiedTime } = (body ?? {}) as Record<string, unknown>;
  const modifiedAt = typeof modifiedTime === "string" ? new Date(modifiedTime) : null;
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    typeof mimeType !== "string" ||
    !modifiedAt ||
    Number.isNaN(modifiedAt.getTime())
  ) {
    throw new DriveError("unavailable");
  }
  const kind = MIME_KINDS[mimeType] ?? "other";
  return { fileId: id, name, kind, modifiedAt, url: driveFileUrl(id, kind) };
}

/**
 * Drive API v3 の REST を `fetch` で呼ぶ本物のドライブ(ADR-002)。
 * アクセストークンはこのインスタンスのメモリにだけ持つ。失っても、リフレッシュトークンから
 * 取り直すだけで結果は変わらない(ADR-013)。
 */
export function createGoogleDrive(options: GoogleDriveOptions): Drive {
  const { config, db, logger } = options;
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const google = config.google;
  if (!google) throw new Error("GOOGLE_CLIENT_ID と GOOGLE_CLIENT_SECRET が必要です");

  const cache = new Map<string, AccessToken>();
  // 同じ利用者の更新が重なったときに、トークンの取得を1回にまとめる
  const refreshing = new Map<string, Promise<AccessToken>>();

  /** 失敗を記録する。資料名・リンク・トークンは載せず、HTTP の状態と Google の理由だけを出す */
  function logApiError(userId: string, status: number | undefined, code: string): void {
    logger.warn("drive api error", { event: "drive_api_error", userId, status, code });
  }

  async function loadRefreshToken(userId: string): Promise<string> {
    const [row] = await db
      .select({ status: t.driveConnections.status, credentials: t.driveConnections.credentials })
      .from(t.driveConnections)
      .where(eq(t.driveConnections.userId, userId));
    if (row?.status !== "active") throw new DriveError("reauth");
    try {
      const { token, rotate } = decryptToken(config.tokenKeys, row.credentials, userId);
      if (rotate) {
        try {
          // 再連携で新しいトークンが保存された後に、古い暗号文で上書きしない
          await db
            .update(t.driveConnections)
            .set({ credentials: encryptToken(config.tokenKeys, token, userId) })
            .where(
              and(
                eq(t.driveConnections.userId, userId),
                eq(t.driveConnections.credentials, row.credentials),
              ),
            );
        } catch {
          // トークンは読めているので、入れ替えの失敗でドライブを止めない。次に取り直すときにやり直す
          logger.warn("token re-encryption failed", { event: "token_rotate_failed", userId });
        }
      }
      return token;
    } catch (error) {
      if (!(error instanceof TokenDecryptError)) throw error;
      // 鍵の設定の問題で、利用者の認可は失われていない。要再連携にはしない(05 3章)
      logger.error("token decrypt failed", { event: "token_decrypt_failed", userId });
      throw new DriveError("unavailable", { cause: error });
    }
  }

  async function requestToken(userId: string): Promise<AccessToken> {
    const refreshToken = await loadRefreshToken(userId);
    // 範囲を drive.file に絞って受け取る。Picker に渡すトークンの権限も、これだけになる
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: google?.clientId ?? "",
      client_secret: google?.clientSecret ?? "",
      scope: DRIVE_FILE_SCOPE,
    });
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await doFetch(TOKEN_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
        });
      } catch (cause) {
        logApiError(userId, undefined, "token_network_error");
        if (attempt === 0) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        throw new DriveError("unavailable", { cause });
      }
      if (response.ok) {
        const data = (await readJson(response)) as {
          access_token?: unknown;
          expires_in?: unknown;
        };
        if (typeof data.access_token !== "string" || typeof data.expires_in !== "number") {
          throw new DriveError("unavailable");
        }
        return { accessToken: data.access_token, expiresAt: now() + data.expires_in * 1000 };
      }
      const { reasons } = await readReasons(response);
      const code = reasons[0] ?? `http_${response.status}`;
      logApiError(userId, response.status, code);
      // 取り消された・期限切れのリフレッシュトークン、許可されていない範囲
      if (reasons.includes("invalid_grant") || reasons.includes("invalid_scope")) {
        cache.delete(userId);
        throw new DriveError("reauth");
      }
      if ((response.status === 429 || response.status >= 500) && attempt === 0) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      throw new DriveError("unavailable");
    }
  }

  async function accessToken(
    userId: string,
    minRemainingMs = EXPIRY_MARGIN_MS,
  ): Promise<AccessToken> {
    const cached = cache.get(userId);
    if (cached && cached.expiresAt - now() > minRemainingMs) return cached;
    let pending = refreshing.get(userId);
    if (!pending) {
      pending = requestToken(userId)
        .then((token) => {
          cache.set(userId, token);
          return token;
        })
        .finally(() => refreshing.delete(userId));
      refreshing.set(userId, pending);
    }
    return pending;
  }

  /**
   * Drive API を呼ぶ。失敗は `DriveError` にし、再試行は1回だけ。
   * `idempotent` が偽(作成・コピー)のときは、処理されたか分からない失敗(通信の失敗・5xx)を再試行しない。
   */
  async function call(
    userId: string,
    url: string,
    init: RequestInit & { idempotent?: boolean } = {},
  ): Promise<unknown> {
    const { idempotent = true, ...request } = init;
    let retried = false;
    let renewedToken = false;
    for (;;) {
      const token = await accessToken(userId);
      let response: Response;
      try {
        response = await doFetch(url, {
          ...request,
          headers: {
            ...(request.body ? { "content-type": "application/json" } : {}),
            authorization: `Bearer ${token.accessToken}`,
          },
        });
      } catch (cause) {
        logApiError(userId, undefined, "network_error");
        if (retried || !idempotent) throw new DriveError("unavailable", { cause });
        retried = true;
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      logger.debug("drive api response", { userId, status: response.status });
      if (response.ok) return readJson(response);

      const reasons = await readReasons(response);
      const verdict = classify(response.status, reasons);
      if (verdict !== "not_accessible") {
        logApiError(userId, response.status, reasons.reasons[0] ?? `http_${response.status}`);
      }
      if (verdict === "renew_token") {
        // 取り直したトークンでも認可エラーなら、利用者の認可が使えない
        cache.delete(userId);
        if (renewedToken) throw new DriveError("reauth");
        renewedToken = true;
        continue;
      }
      const retryable = verdict === "rate_limited" || (verdict === "server_error" && idempotent);
      if (retryable && !retried) {
        retried = true;
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      throw new DriveError(
        verdict === "rate_limited" || verdict === "server_error" ? "unavailable" : verdict,
      );
    }
  }

  const fileUrl = (fileId: string, path = "") =>
    `${DRIVE_API}/${encodeURIComponent(fileId)}${path}`;
  const query = `fields=${FILE_FIELDS}&supportsAllDrives=true`;

  return {
    async getFile(userId, fileId) {
      return toFile(await call(userId, `${fileUrl(fileId)}?${query}`));
    },
    async createFile(userId, kind, name) {
      return toFile(
        await call(userId, `${DRIVE_API}?${query}`, {
          method: "POST",
          idempotent: false,
          body: JSON.stringify({ name, mimeType: CREATE_MIME[kind] }),
        }),
      );
    },
    async copyFile(userId, sourceFileId, name) {
      // parents を指定しないと、コピーは元のファイルのフォルダに入る
      return toFile(
        await call(userId, `${fileUrl(sourceFileId, "/copy")}?${query}`, {
          method: "POST",
          idempotent: false,
          body: JSON.stringify({ name, parents: ["root"] }),
        }),
      );
    },
    async issuePickerToken(userId): Promise<PickerToken> {
      const token = await accessToken(userId, PICKER_MIN_REMAINING_MS);
      return { accessToken: token.accessToken, expiresAt: new Date(token.expiresAt) };
    },
  };
}
