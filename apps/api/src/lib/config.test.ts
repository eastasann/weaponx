import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config";

const base = { DATABASE_URL: "postgres://u:p@db:5432/weaponx" };

describe("loadConfig", () => {
  test("DATABASE_URL を設定に入れる", () => {
    expect(loadConfig(base).databaseUrl).toBe(base.DATABASE_URL);
  });

  test("DATABASE_URL が無い・形式が違うと、変数名だけを出して止まる", () => {
    expect(() => loadConfig({})).toThrow("DATABASE_URL");
    const err = (() => {
      try {
        loadConfig({ DATABASE_URL: "mysql://secret-user:secret-pass@x" });
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
});
