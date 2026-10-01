import { describe, expect, test } from "bun:test";
import { parseContext, readIdentity, serializeContext } from "./oauth";

const CLIENT_ID = "client-1.apps.googleusercontent.com";
const NOW = Date.UTC(2026, 9, 1);

function idToken(claims: Record<string, unknown>): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256" })}.${part(claims)}.signature`;
}

const valid = {
  sub: "1234567890",
  email: "Yamada@Example.com",
  email_verified: true,
  name: "山田 太郎",
  picture: "https://lh3.googleusercontent.com/a/x",
  aud: CLIENT_ID,
  iss: "https://accounts.google.com",
  exp: NOW / 1000 + 3600,
};

describe("readIdentity(ID トークンのクレームの確認)", () => {
  test("有効なクレームから、メールを小文字にして取り出す", () => {
    expect(readIdentity(idToken(valid), CLIENT_ID, NOW)).toEqual({
      sub: "1234567890",
      email: "yamada@example.com",
      name: "山田 太郎",
      picture: "https://lh3.googleusercontent.com/a/x",
    });
  });

  test("iss は accounts.google.com の2つの表記を受け付け、aud は配列でもよい", () => {
    expect(
      readIdentity(idToken({ ...valid, iss: "accounts.google.com" }), CLIENT_ID, NOW),
    ).not.toBeNull();
    expect(
      readIdentity(idToken({ ...valid, aud: ["other", CLIENT_ID] }), CLIENT_ID, NOW),
    ).not.toBeNull();
    expect(
      readIdentity(idToken({ ...valid, email_verified: "true" }), CLIENT_ID, NOW),
    ).not.toBeNull();
  });

  test("aud・iss・exp・email_verified・sub・email のどれかが合わなければ null", () => {
    const bad: Record<string, unknown>[] = [
      { aud: "someone-else" },
      { iss: "https://evil.example.com" },
      { exp: NOW / 1000 - 1 },
      { exp: undefined },
      { email_verified: false },
      { email_verified: undefined },
      { sub: "" },
      { email: undefined },
    ];
    for (const override of bad) {
      expect(readIdentity(idToken({ ...valid, ...override }), CLIENT_ID, NOW)).toBeNull();
    }
    expect(readIdentity("not-a-jwt", CLIENT_ID, NOW)).toBeNull();
  });

  test("name が無ければ null、https でない画像の URL は保存しない", () => {
    const result = readIdentity(
      idToken({ ...valid, name: undefined, picture: "http://x.example.com/a.png" }),
      CLIENT_ID,
      NOW,
    );
    expect(result?.name).toBeNull();
    expect(result?.picture).toBeNull();
  });
});

describe("parseContext(wx_oauth_ctx)", () => {
  test("serializeContext で作った値を読み戻せる", () => {
    const ctx = {
      mode: "login",
      returnTo: "/projects/1?x=日本語",
      locale: "ja",
      consent: true,
    } as const;
    expect(parseContext(serializeContext(ctx))).toEqual(ctx);
  });

  test("無い・壊れている・形式が違う値は null", () => {
    expect(parseContext(undefined)).toBeNull();
    expect(parseContext("%7Bbroken")).toBeNull();
    expect(parseContext(encodeURIComponent(JSON.stringify({ mode: "admin" })))).toBeNull();
    expect(
      parseContext(
        encodeURIComponent(
          JSON.stringify({ mode: "login", returnTo: "/", locale: "fr", consent: false }),
        ),
      ),
    ).toBeNull();
  });
});
