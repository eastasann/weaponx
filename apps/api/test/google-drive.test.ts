import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { encryptToken } from "../src/auth/token-crypto";
import * as schema from "../src/db/schema";
import { createGoogleDrive, DriveError } from "../src/drive";
import type { Config } from "../src/lib/config";
import { createLogger } from "../src/lib/logger";
import { createTestContext, type Json, TEST_KEY, USERS } from "./helpers";

const ctx = createTestContext();
beforeEach(() => ctx.seed());
afterAll(() => ctx.close());

const REFRESH_TOKEN = "1//refresh-secret";
const FILE_ID = "1AbCdEfGhIjK";

type Call = { url: string; method: string; headers: Headers; body: string | undefined };
type Responder = (call: Call, index: number) => Response | Promise<Response>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const googleError = (status: number, reason: string) =>
  json(status, { error: { code: status, errors: [{ reason }] } });
const tokenOk = (token = "ya29.token", expiresIn = 3600) =>
  json(200, { access_token: token, expires_in: expiresIn });
const fileOk = (mimeType = "application/vnd.google-apps.presentation") =>
  json(200, { id: FILE_ID, name: "提案書", mimeType, modifiedTime: "2026-09-10T00:40:00.000Z" });

/** Google への通信を差し替えた本物のドライブ。`token` はトークンエンドポイント、`api` は Drive API */
function setup(
  handlers: { token?: Responder; api?: Responder } = {},
  keys: Config["tokenKeys"] = ctx.config.tokenKeys,
) {
  const calls: Call[] = [];
  const tokenCalls: Call[] = [];
  const sleeps: number[] = [];
  const logs: Json[] = [];
  let clock = Date.UTC(2026, 9, 1);
  const fakeFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body === undefined ? undefined : String(init.body),
    };
    const isToken = call.url.startsWith("https://oauth2.googleapis.com/token");
    const list = isToken ? tokenCalls : calls;
    list.push(call);
    const handler = isToken
      ? (handlers.token ?? (() => tokenOk()))
      : (handlers.api ?? (() => fileOk()));
    return handler(call, list.length - 1);
  };
  const drive = createGoogleDrive({
    config: {
      tokenKeys: keys,
      google: { clientId: "client-id", clientSecret: "client-secret" },
    },
    db: ctx.db,
    logger: createLogger({ level: "info", write: (line) => logs.push(JSON.parse(line)) }),
    fetch: fakeFetch as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => clock,
  });
  return { drive, calls, tokenCalls, sleeps, logs, advance: (ms: number) => (clock += ms) };
}

let userId: string;
beforeEach(async () => {
  userId = await ctx.userId(USERS.sato);
  await ctx.db
    .update(schema.driveConnections)
    .set({ credentials: encryptToken(ctx.config.tokenKeys, REFRESH_TOKEN, userId) })
    .where(eq(schema.driveConnections.userId, userId));
});

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DriveError) return error.reason;
    throw error;
  }
  return "ok";
}

describe("getFile", () => {
  test("ファイルの情報を返し、種別は MIME タイプから決める", async () => {
    const { drive, calls } = setup({
      api: () => fileOk("application/vnd.google-apps.document"),
    });
    const file = await drive.getFile(userId, FILE_ID);
    expect(file).toEqual({
      fileId: FILE_ID,
      name: "提案書",
      kind: "google_doc",
      modifiedAt: new Date("2026-09-10T00:40:00.000Z"),
      url: `https://docs.google.com/document/d/${FILE_ID}/edit`,
    });
    expect(calls[0]?.url).toContain(`/drive/v3/files/${FILE_ID}?`);
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer ya29.token");
  });

  test("MIME タイプから google_slides・google_sheets・pdf・other を決める", async () => {
    const kinds: [string, string][] = [
      ["application/vnd.google-apps.presentation", "google_slides"],
      ["application/vnd.google-apps.spreadsheet", "google_sheets"],
      ["application/pdf", "pdf"],
      ["image/png", "other"],
    ];
    for (const [mime, kind] of kinds) {
      const { drive } = setup({ api: () => fileOk(mime) });
      expect((await drive.getFile(userId, FILE_ID)).kind).toBe(kind as never);
    }
  });

  test("アクセストークンをメモリにキャッシュし、期限が近づいたら取り直す", async () => {
    const { drive, tokenCalls, advance } = setup({ token: () => tokenOk("ya29.a", 3600) });
    await drive.getFile(userId, FILE_ID);
    await drive.getFile(userId, FILE_ID);
    expect(tokenCalls).toHaveLength(1);
    advance(3600_000 - 30_000);
    await drive.getFile(userId, FILE_ID);
    expect(tokenCalls).toHaveLength(2);
  });

  test("同時の呼び出しでも、トークンの取得は1回にまとめる", async () => {
    const { drive, tokenCalls } = setup();
    await Promise.all([1, 2, 3].map(() => drive.getFile(userId, FILE_ID)));
    expect(tokenCalls).toHaveLength(1);
  });

  test("トークンの取得には drive.file だけを求め、リフレッシュトークンを送る", async () => {
    const { drive, tokenCalls } = setup();
    await drive.getFile(userId, FILE_ID);
    const body = new URLSearchParams(tokenCalls[0]?.body);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe(REFRESH_TOKEN);
    expect(body.get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
  });

  test("応答の分け方: 404・ファイル単位の 403 は not_accessible(ログに出さない)", async () => {
    for (const response of [
      () => googleError(404, "notFound"),
      () => googleError(403, "insufficientFilePermissions"),
      () => googleError(403, "appNotAuthorizedToFile"),
    ]) {
      const { drive, logs } = setup({ api: response });
      expect(await reason(drive.getFile(userId, FILE_ID))).toBe("not_accessible");
      expect(logs).toHaveLength(0);
    }
  });

  test("応答の分け方: 範囲不足の 403 は、トークンを取り直しても同じなら reauth", async () => {
    const { drive, logs, tokenCalls } = setup({
      api: () =>
        json(403, {
          error: {
            code: 403,
            errors: [{ reason: "insufficientPermissions" }],
            details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }],
          },
        }),
    });
    expect(await reason(drive.getFile(userId, FILE_ID))).toBe("reauth");
    expect(tokenCalls).toHaveLength(2);
    expect(logs.map((l) => l.event)).toEqual(["drive_api_error", "drive_api_error"]);
    expect(logs[0]).toMatchObject({ userId, status: 403, code: "insufficientPermissions" });
  });

  test("再連携の前に取った古いアクセストークンの 403 は、取り直して成功する", async () => {
    const { drive, calls, tokenCalls } = setup({
      token: (_c, i) => tokenOk(i === 0 ? "ya29.old" : "ya29.new"),
      api: (call) =>
        call.headers.get("authorization") === "Bearer ya29.old"
          ? googleError(403, "insufficientPermissions")
          : fileOk(),
    });
    expect((await drive.getFile(userId, FILE_ID)).fileId).toBe(FILE_ID);
    expect(tokenCalls).toHaveLength(2);
    expect(calls.map((c) => c.headers.get("authorization"))).toEqual([
      "Bearer ya29.old",
      "Bearer ya29.new",
    ]);
  });

  test("401 は、トークンを取り直して1回だけやり直す。それでも 401 なら reauth", async () => {
    const recovered = setup({
      api: (_call, i) => (i === 0 ? googleError(401, "authError") : fileOk()),
    });
    expect((await recovered.drive.getFile(userId, FILE_ID)).name).toBe("提案書");
    expect(recovered.tokenCalls).toHaveLength(2);

    const rejected = setup({ api: () => googleError(401, "authError") });
    expect(await reason(rejected.drive.getFile(userId, FILE_ID))).toBe("reauth");
    expect(rejected.tokenCalls).toHaveLength(2);
  });

  test("レート制限・5xx・通信の失敗は、1回だけ待って再試行し、だめなら unavailable", async () => {
    for (const failing of [
      () => googleError(403, "rateLimitExceeded"),
      () => googleError(403, "userRateLimitExceeded"),
      () => json(429, {}),
      () => json(503, {}),
    ]) {
      const ok = setup({ api: (_c, i) => (i === 0 ? failing() : fileOk()) });
      expect((await ok.drive.getFile(userId, FILE_ID)).fileId).toBe(FILE_ID);
      expect(ok.sleeps).toEqual([1000]);
      expect(ok.logs.map((l) => l.event)).toEqual(["drive_api_error"]);

      const ng = setup({ api: failing });
      expect(await reason(ng.drive.getFile(userId, FILE_ID))).toBe("unavailable");
      expect(ng.calls).toHaveLength(2);
    }
    const network = setup({
      api: () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(await reason(network.drive.getFile(userId, FILE_ID))).toBe("unavailable");
    expect(network.calls).toHaveLength(2);
  });

  test("アプリ側の設定の問題(API が無効など)や想定外の応答は unavailable で、要再連携にしない", async () => {
    for (const response of [
      () => googleError(403, "accessNotConfigured"),
      () => googleError(403, "storageQuotaExceeded"),
      () => new Response("<html>bad gateway</html>", { status: 200 }),
      () => googleError(400, "badRequest"),
      () => json(200, { id: FILE_ID }),
    ]) {
      const { drive } = setup({ api: response });
      expect(await reason(drive.getFile(userId, FILE_ID))).toBe("unavailable");
    }
  });

  test("ログにファイルの ID・名前・トークンを出さない", async () => {
    const { drive, logs } = setup({ api: () => googleError(403, "rateLimitExceeded") });
    await reason(drive.getFile(userId, FILE_ID));
    const text = JSON.stringify(logs);
    expect(text).not.toContain(FILE_ID);
    expect(text).not.toContain("提案書");
    expect(text).not.toContain(REFRESH_TOKEN);
    expect(text).not.toContain("ya29");
  });
});

describe("トークンの取得", () => {
  test("invalid_grant・invalid_scope は reauth(取り消された・範囲が無い)", async () => {
    for (const error of ["invalid_grant", "invalid_scope"]) {
      const { drive, calls } = setup({ token: () => json(400, { error }) });
      expect(await reason(drive.getFile(userId, FILE_ID))).toBe("reauth");
      expect(calls).toHaveLength(0);
    }
  });

  test("invalid_client などの設定の問題や 5xx は unavailable。5xx は1回だけ再試行する", async () => {
    const config = setup({ token: () => json(401, { error: "invalid_client" }) });
    expect(await reason(config.drive.getFile(userId, FILE_ID))).toBe("unavailable");
    expect(config.tokenCalls).toHaveLength(1);

    const flaky = setup({ token: (_c, i) => (i === 0 ? json(500, {}) : tokenOk()) });
    expect((await flaky.drive.getFile(userId, FILE_ID)).fileId).toBe(FILE_ID);

    const down = setup({ token: () => json(500, {}) });
    expect(await reason(down.drive.getFile(userId, FILE_ID))).toBe("unavailable");
    expect(down.tokenCalls).toHaveLength(2);
  });

  test("要再連携の利用者・連携の行が無い利用者には Google を呼ばない", async () => {
    const tanaka = await ctx.userId(USERS.tanaka);
    const none = await ctx.userId(USERS.newcomer);
    for (const id of [tanaka, none]) {
      const { drive, calls, tokenCalls } = setup();
      expect(await reason(drive.getFile(id, FILE_ID))).toBe("reauth");
      expect(calls.length + tokenCalls.length).toBe(0);
    }
  });

  test("トークンの入れ替え(暗号化し直し)に失敗しても、読めたトークンでドライブを使う", async () => {
    const rotated = [{ id: "k2", key: Buffer.alloc(32, 2) }, ...ctx.config.tokenKeys];
    const logs: Json[] = [];
    // 入れ替えの書き込み(update)だけを失敗させる
    const failingDb = new Proxy(ctx.db, {
      get(target, prop, receiver) {
        if (prop === "update") {
          return () => {
            throw new Error("db down");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const drive = createGoogleDrive({
      config: { tokenKeys: rotated, google: { clientId: "c", clientSecret: "s" } },
      db: failingDb,
      logger: createLogger({ level: "info", write: (line) => logs.push(JSON.parse(line)) }),
      fetch: (async (input: Parameters<typeof fetch>[0]) =>
        String(input).startsWith("https://oauth2.googleapis.com/token")
          ? tokenOk()
          : fileOk()) as typeof fetch,
    });
    expect((await drive.getFile(userId, FILE_ID)).fileId).toBe(FILE_ID);
    expect(logs.find((l) => l.event === "token_rotate_failed")).toMatchObject({ userId });
  });

  test("復号できないときは token_decrypt_failed を記録し、unavailable にする(要再連携にしない)", async () => {
    await ctx.db
      .update(schema.driveConnections)
      .set({ credentials: "gone:AAAA:AAAA:AAAA" })
      .where(eq(schema.driveConnections.userId, userId));
    const { drive, logs, calls, tokenCalls } = setup();
    expect(await reason(drive.getFile(userId, FILE_ID))).toBe("unavailable");
    expect(logs).toEqual([
      { severity: "ERROR", message: "token decrypt failed", event: "token_decrypt_failed", userId },
    ]);
    expect(calls.length + tokenCalls.length).toBe(0);
    const [row] = await ctx.db
      .select()
      .from(schema.driveConnections)
      .where(eq(schema.driveConnections.userId, userId));
    expect(row?.status).toBe("active");
  });

  test("先頭以外の鍵で復号できたときは、先頭の鍵で暗号化し直して保存する(ADR-012)", async () => {
    const key2 = `k2:${Buffer.alloc(32, 2).toString("base64")}`;
    const keys = ctx.config.tokenKeys;
    const rotated = [
      { id: "k2", key: Buffer.from(key2.split(":")[1] as string, "base64") },
      ...keys,
    ];
    const { drive, tokenCalls } = setup({}, rotated);
    await drive.getFile(userId, FILE_ID);
    expect(new URLSearchParams(tokenCalls[0]?.body).get("refresh_token")).toBe(REFRESH_TOKEN);
    const [row] = await ctx.db
      .select()
      .from(schema.driveConnections)
      .where(eq(schema.driveConnections.userId, userId));
    expect(row?.credentials.startsWith("k2:")).toBe(true);
    expect(TEST_KEY.startsWith("test:")).toBe(true);
  });
});

describe("createFile・copyFile", () => {
  test("マイドライブ直下にドキュメント・スライドを作る", async () => {
    const { drive, calls } = setup({
      api: () => fileOk("application/vnd.google-apps.document"),
    });
    const file = await drive.createFile(userId, "google_doc", "新しい資料");
    expect(file.kind).toBe("google_doc");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toStartWith("https://www.googleapis.com/drive/v3/files?");
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      name: "新しい資料",
      mimeType: "application/vnd.google-apps.document",
    });
    await drive.createFile(userId, "google_slides", "スライド");
    expect(JSON.parse(calls[1]?.body ?? "").mimeType).toBe(
      "application/vnd.google-apps.presentation",
    );
  });

  test("コピーはマイドライブ直下に置く。元のファイルを使えないときは not_accessible", async () => {
    const { drive, calls } = setup();
    await drive.copyFile(userId, FILE_ID, "コピー");
    expect(calls[0]?.url).toContain(`/files/${FILE_ID}/copy?`);
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({ name: "コピー", parents: ["root"] });

    const missing = setup({ api: () => googleError(404, "notFound") });
    expect(await reason(missing.drive.copyFile(userId, FILE_ID, "コピー"))).toBe("not_accessible");
  });

  test("作成・コピーは、処理されたか分からない失敗(5xx・通信の失敗)を再試行しない。レート制限は再試行する", async () => {
    for (const failing of [
      () => json(500, {}),
      () => {
        throw new TypeError("fetch failed");
      },
    ]) {
      const create = setup({ api: failing });
      expect(await reason(create.drive.createFile(userId, "google_doc", "x"))).toBe("unavailable");
      expect(create.calls).toHaveLength(1);
      const copy = setup({ api: failing });
      expect(await reason(copy.drive.copyFile(userId, FILE_ID, "x"))).toBe("unavailable");
      expect(copy.calls).toHaveLength(1);
    }
    const limited = setup({ api: (_c, i) => (i === 0 ? json(429, {}) : fileOk()) });
    expect((await limited.drive.createFile(userId, "google_doc", "x")).fileId).toBe(FILE_ID);
    expect(limited.calls).toHaveLength(2);
  });

  test("認可エラー・一時的な失敗の分け方は getFile と同じ", async () => {
    const reauth = setup({ api: () => googleError(403, "insufficientPermissions") });
    expect(await reason(reauth.drive.createFile(userId, "google_doc", "x"))).toBe("reauth");
    const down = setup({ api: () => json(503, {}) });
    expect(await reason(down.drive.copyFile(userId, FILE_ID, "x"))).toBe("unavailable");
  });
});

describe("issuePickerToken", () => {
  test("アクセストークンと期限を返す。残りが5分を切ったら取り直す", async () => {
    const { drive, tokenCalls, advance } = setup({ token: () => tokenOk("ya29.p", 3600) });
    const token = await drive.issuePickerToken(userId);
    expect(token.accessToken).toBe("ya29.p");
    expect(token.expiresAt.getTime()).toBe(Date.UTC(2026, 9, 1) + 3600_000);
    await drive.issuePickerToken(userId);
    expect(tokenCalls).toHaveLength(1);
    advance(3600_000 - 4 * 60_000);
    await drive.issuePickerToken(userId);
    expect(tokenCalls).toHaveLength(2);
  });

  test("invalid_grant は reauth", async () => {
    const { drive } = setup({ token: () => json(400, { error: "invalid_grant" }) });
    expect(await reason(drive.issuePickerToken(userId))).toBe("reauth");
  });
});
