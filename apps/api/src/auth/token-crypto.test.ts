import { describe, expect, test } from "bun:test";
import type { TokenKey } from "../lib/config";
import { decryptToken, encryptToken, TokenDecryptError } from "./token-crypto";

const U = "user-1";
const k1: TokenKey = { id: "k1", key: Buffer.alloc(32, 1) };
const k2: TokenKey = { id: "k2", key: Buffer.alloc(32, 2) };

describe("リフレッシュトークンの暗号化", () => {
  test("{鍵ID}:{IV}:{暗号文}:{タグ} の形で、先頭の鍵で暗号化し、復号できる", () => {
    const stored = encryptToken([k1], "1//refresh-token", U);
    const parts = stored.split(":");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("k1");
    expect(Buffer.from(parts[1] as string, "base64url")).toHaveLength(12);
    expect(stored).not.toContain("refresh-token");
    expect(decryptToken([k1], stored, U)).toEqual({ token: "1//refresh-token", rotate: false });
  });

  test("同じ平文でも、IV が毎回変わるので暗号文は変わる", () => {
    expect(encryptToken([k1], "x", U)).not.toBe(encryptToken([k1], "x", U));
  });

  test("先頭以外の鍵で復号できたときは、暗号化し直すよう知らせる(鍵の入れ替え。ADR-012)", () => {
    const old = encryptToken([k1], "token", U);
    expect(decryptToken([k2, k1], old, U)).toEqual({ token: "token", rotate: true });
    const rotated = encryptToken([k2, k1], "token", U);
    expect(rotated.startsWith("k2:")).toBe(true);
    expect(decryptToken([k2, k1], rotated, U).rotate).toBe(false);
  });

  test("鍵が無い・形式が違う・改ざんされた・別の鍵のときは TokenDecryptError", () => {
    const stored = encryptToken([k1], "token", U);
    const [id, iv, body, tag] = stored.split(":") as [string, string, string, string];
    const flipped = Buffer.from(body, "base64url");
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    const cases = [
      stored.replace("k1:", "gone:"),
      "demo:dummy:dummy:dummy",
      "",
      `${id}:${iv}:${body}`,
      `${id}:${iv}:${body}:${tag}:extra`,
      `${id}:${iv}:${flipped.toString("base64url")}:${tag}`,
    ];
    for (const bad of cases) {
      expect(() => decryptToken([k1], bad, U)).toThrow(TokenDecryptError);
    }
    expect(() => decryptToken([{ id: "k1", key: Buffer.alloc(32, 9) }], stored, U)).toThrow(
      TokenDecryptError,
    );
  });

  test("暗号文を別の利用者の行へ移しても復号できない(利用者 ID を追加認証データにしている)", () => {
    const stored = encryptToken([k1], "token", U);
    expect(() => decryptToken([k1], stored, "user-2")).toThrow(TokenDecryptError);
  });

  test("短い認証タグ・IV は受け付けない", () => {
    const [id, iv, body, tag] = encryptToken([k1], "token", U).split(":") as [
      string,
      string,
      string,
      string,
    ];
    const shortTag = Buffer.from(tag, "base64url").subarray(0, 4).toString("base64url");
    const shortIv = Buffer.from(iv, "base64url").subarray(0, 8).toString("base64url");
    expect(() => decryptToken([k1], `${id}:${iv}:${body}:${shortTag}`, U)).toThrow(
      TokenDecryptError,
    );
    expect(() => decryptToken([k1], `${id}:${shortIv}:${body}:${tag}`, U)).toThrow(
      TokenDecryptError,
    );
  });

  test("鍵が無いときは暗号化しない", () => {
    expect(() => encryptToken([], "x", U)).toThrow();
  });
});
