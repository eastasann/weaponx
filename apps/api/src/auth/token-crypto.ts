import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { TokenKey } from "../lib/config";

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** 鍵が無い・形式が違う・認証タグが合わないなど、保存済みのトークンを読めないこと */
export class TokenDecryptError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("Stored token could not be decrypted", options);
  }
}

/**
 * 先頭の鍵で AES-256-GCM 暗号化する。形式は `{鍵ID}:{IV}:{暗号文}:{タグ}`(各 base64url。ADR-012)。
 * `userId` を追加認証データにして、暗号文を別の利用者の行へ移しても復号できないようにする。
 */
export function encryptToken(keys: readonly TokenKey[], plaintext: string, userId: string): string {
  const [current] = keys;
  if (!current) throw new Error("No token encryption key is configured");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", current.key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(userId));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [current.id, iv, body, cipher.getAuthTag()]
    .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
    .join(":");
}

/**
 * 保存済みのトークンを、鍵 ID が指す鍵で復号する。`rotate` が真なら先頭以外の鍵で復号したので、
 * 呼び出し側は先頭の鍵で暗号化し直して保存する(鍵の入れ替え。ADR-012)。
 */
export function decryptToken(
  keys: readonly TokenKey[],
  stored: string,
  userId: string,
): { token: string; rotate: boolean } {
  const [keyId, iv, body, tag, ...rest] = stored.split(":");
  const key = keys.find((k) => k.id === keyId);
  if (!key || !iv || body === undefined || !tag || rest.length > 0) throw new TokenDecryptError();
  try {
    const ivBytes = Buffer.from(iv, "base64url");
    const tagBytes = Buffer.from(tag, "base64url");
    // 短いタグや IV を受け付けると、認証の強さが下がる
    if (ivBytes.length !== IV_BYTES || tagBytes.length !== TAG_BYTES) throw new TokenDecryptError();
    const decipher = createDecipheriv("aes-256-gcm", key.key, ivBytes, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(Buffer.from(userId));
    decipher.setAuthTag(tagBytes);
    const token = Buffer.concat([
      decipher.update(Buffer.from(body, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    return { token, rotate: key.id !== keys[0]?.id };
  } catch (error) {
    throw new TokenDecryptError({ cause: error });
  }
}
