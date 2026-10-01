import { eq } from "drizzle-orm";
import { seedDemoData } from "../scripts/seed";
import { createApp } from "../src/app";
import { createDb } from "../src/db/client";
import * as schema from "../src/db/schema";
import { createMockDrive, type Drive, type MockDrive } from "../src/drive";
import { type Config, loadConfig } from "../src/lib/config";
import { createLogger } from "../src/lib/logger";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL が設定されていません");

export const ORIGIN = "http://localhost:5173";

/** 32バイトの鍵(テスト用。本番の鍵ではない) */
export const TEST_KEY = `test:${Buffer.alloc(32, 7).toString("base64")}`;

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: url,
    APP_ORIGIN: ORIGIN,
    TOKEN_ENCRYPTION_KEYS: TEST_KEY,
    DEV_LOGIN_ENABLED: "true",
    DRIVE_MODE: "mock",
    APP_VERSION: "test",
    ...overrides,
  });
}

// biome-ignore lint/suspicious/noExplicitAny: テストが応答の JSON を深く辿るので、形は固定しない
export type Json = Record<string, any>;
export type Reply = { status: number; json: Json; headers: Headers; text: string };

export type TestContext = ReturnType<typeof createTestContext>;

/** 結合テストの土台。API は HTTP を経由せず `app.handle` で呼ぶ(URL のホストは localhost にする) */
export function createTestContext(
  overrides: Record<string, string> = {},
  options: { drive?: (mock: MockDrive) => Drive } = {},
) {
  const config = testConfig(overrides);
  const { db, sql } = createDb(url as string);
  const logs: Json[] = [];
  const logger = createLogger({
    level: "debug",
    gcpProjectId: config.gcpProjectId,
    write: (line) => logs.push(JSON.parse(line)),
  });
  const mockDrive = createMockDrive(db);
  const app = createApp({ config, db, logger, drive: options.drive?.(mockDrive) ?? mockDrive });

  async function call(
    method: string,
    path: string,
    options: {
      cookie?: string;
      body?: unknown;
      rawBody?: string;
      origin?: string | null;
      headers?: Record<string, string>;
    } = {},
  ): Promise<Reply> {
    const headers: Record<string, string> = { ...options.headers };
    if (options.cookie) headers.cookie = options.cookie;
    if (options.origin !== null && method !== "GET") headers.origin = options.origin ?? ORIGIN;
    const raw =
      options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
    if (raw !== undefined && !headers["content-type"]) headers["content-type"] = "application/json";
    const response = await app.handle(
      new Request(`http://localhost${path}`, { method, headers, body: raw }),
    );
    const text = await response.text();
    // onAfterResponse(リクエストのログ)は応答を返した後に走るので、1回譲る
    await Bun.sleep(1);
    // 204 などの本文が無い応答は空のオブジェクトにする。JSON でない本文は構文エラーにして気づく
    const json: Json = text ? JSON.parse(text) : {};
    return { status: response.status, json, headers: response.headers, text };
  }

  /** 開発用ログインで入り、`cookie` ヘッダーに渡す文字列を返す */
  async function login(email: string): Promise<string> {
    const reply = await call("POST", "/api/dev/login", { body: { email } });
    if (reply.status !== 204) throw new Error(`ログインできません: ${reply.status} ${reply.text}`);
    return cookieHeader(reply.headers);
  }

  async function projectId(name: string): Promise<string> {
    const [row] = await db.select().from(schema.projects).where(eq(schema.projects.name, name));
    if (!row) throw new Error(`案件が見つかりません: ${name}`);
    return row.id;
  }

  /** 版の資料名から版の ID(シードの資料名は版ごとに一意) */
  async function documentId(name: string): Promise<string> {
    const [row] = await db.select().from(schema.documents).where(eq(schema.documents.name, name));
    if (!row) throw new Error(`版が見つかりません: ${name}`);
    return row.id;
  }

  async function seriesId(name: string): Promise<string> {
    const [row] = await db.select().from(schema.documents).where(eq(schema.documents.name, name));
    if (!row) throw new Error(`版が見つかりません: ${name}`);
    return row.seriesId;
  }

  async function userId(email: string): Promise<string> {
    const [row] = await db.select().from(schema.users).where(eq(schema.users.email, email));
    if (!row) throw new Error(`利用者が見つかりません: ${email}`);
    return row.id;
  }

  return {
    config,
    db,
    sql,
    app,
    logs,
    call,
    login,
    projectId,
    documentId,
    seriesId,
    userId,
    mockDrive,
    seed: async () => {
      await seedDemoData(db);
      mockDrive.reset();
    },
    close: () => sql.end(),
  };
}

/** Set-Cookie の名前と値だけを、リクエストの `cookie` ヘッダーの形にする(削除された Cookie は除く) */
export function cookieHeader(headers: Headers): string {
  return headers
    .getSetCookie()
    .map((c) => c.split(";")[0] as string)
    .filter((c) => !c.endsWith("="))
    .join("; ");
}

export const USERS = {
  yamada: "yamada@example.com",
  sato: "sato@example.com",
  suzuki: "suzuki@example.com",
  tanaka: "tanaka@example.com",
  newcomer: "new@example.com",
} as const;
