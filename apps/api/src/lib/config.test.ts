import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config";

const KEY = `k1:${Buffer.alloc(32, 1).toString("base64")}`;
const base = {
  DATABASE_URL: "postgres://u:p@db:5432/weaponx",
  APP_ORIGIN: "http://localhost:5173",
  TOKEN_ENCRYPTION_KEYS: KEY,
};

describe("loadConfig", () => {
  test("DATABASE_URL を設定に入れる", () => {
    expect(loadConfig(base).databaseUrl).toBe(base.DATABASE_URL);
  });

  test("DATABASE_URL が無い・形式が違うと、変数名だけを出して止まる", () => {
    expect(() => loadConfig({ ...base, DATABASE_URL: undefined })).toThrow("DATABASE_URL");
    const err = (() => {
      try {
        loadConfig({ ...base, DATABASE_URL: "mysql://secret-user:secret-pass@x" });
      } catch (e) {
        return String(e);
      }
      return "";
    })();
    expect(err).toContain("DATABASE_URL");
    expect(err).not.toContain("secret");
  });

  test("本番では開発用ログインとドライブの模擬を使えない", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "production" })).toThrow("本番では");
  });

  test("APP_ORIGIN はパスを持たない http(s) のオリジン。https のときだけ Cookie に Secure を付ける", () => {
    expect(loadConfig(base).secureCookies).toBe(false);
    expect(loadConfig({ ...base, APP_ORIGIN: "https://weaponx.example.com" }).secureCookies).toBe(
      true,
    );
    for (const bad of ["", "localhost:5173", "http://localhost:5173/", "ftp://x"]) {
      expect(() => loadConfig({ ...base, APP_ORIGIN: bad })).toThrow("APP_ORIGIN");
    }
  });

  test("TOKEN_ENCRYPTION_KEYS は {鍵ID}:{32バイトの base64} のカンマ区切り。値はエラーに出さない", () => {
    const two = `${KEY},k2:${Buffer.alloc(32, 2).toString("base64")}`;
    expect(() => loadConfig({ ...base, TOKEN_ENCRYPTION_KEYS: two })).not.toThrow();
    const bad = [
      "",
      "k1",
      `k1:${Buffer.alloc(16).toString("base64")}`,
      `:${KEY}`,
      `${KEY},`,
      `a:b:c`,
    ];
    for (const value of bad) {
      expect(() => loadConfig({ ...base, TOKEN_ENCRYPTION_KEYS: value })).toThrow(
        "TOKEN_ENCRYPTION_KEYS",
      );
    }
    const err = (() => {
      try {
        loadConfig({ ...base, TOKEN_ENCRYPTION_KEYS: "secret-id:secret-key" });
      } catch (e) {
        return String(e);
      }
      return "";
    })();
    expect(err).not.toContain("secret-");
  });

  test("Picker の設定は DRIVE_MODE=google のときだけ必須で、mock では null", () => {
    expect(loadConfig(base).picker).toBeNull();
    const client = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" };
    expect(() => loadConfig({ ...base, ...client, DRIVE_MODE: "google" })).toThrow(
      "GOOGLE_PICKER_API_KEY",
    );
    const google = loadConfig({
      ...base,
      ...client,
      DRIVE_MODE: "google",
      GOOGLE_PICKER_API_KEY: "AIza",
      GOOGLE_PROJECT_NUMBER: "123",
    });
    expect(google.picker).toEqual({ apiKey: "AIza", appId: "123" });
  });

  test("OAuth クライアントは DRIVE_MODE=google のときだけ必須。両方が入っているときだけ使える", () => {
    const picker = { GOOGLE_PICKER_API_KEY: "AIza", GOOGLE_PROJECT_NUMBER: "123" };
    expect(loadConfig(base).google).toBeNull();
    expect(loadConfig({ ...base, GOOGLE_CLIENT_ID: "id" }).google).toBeNull();
    expect(() => loadConfig({ ...base, ...picker, DRIVE_MODE: "google" })).toThrow(
      "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET",
    );
    const google = loadConfig({
      ...base,
      ...picker,
      DRIVE_MODE: "google",
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
    });
    expect(google.google).toEqual({ clientId: "id", clientSecret: "secret" });
  });

  test("暗号化鍵は並びのまま取り出す(先頭が暗号化に使う鍵)", () => {
    const k2 = `k2:${Buffer.alloc(32, 2).toString("base64")}`;
    const keys = loadConfig({ ...base, TOKEN_ENCRYPTION_KEYS: `${k2},${KEY}` }).tokenKeys;
    expect(keys.map((k) => k.id)).toEqual(["k2", "k1"]);
    expect(keys[0]?.key).toEqual(Buffer.alloc(32, 2));
  });

  test("GCP_PROJECT_ID は空でもよい", () => {
    expect(loadConfig(base).gcpProjectId).toBe("");
    expect(loadConfig({ ...base, GCP_PROJECT_ID: "p" }).gcpProjectId).toBe("p");
  });
});
