// biome-ignore-all lint/suspicious/noDocumentCookie: テストで Cookie を置く・消すのに使う
import { afterEach, describe, expect, test } from "bun:test";
import { consumeNotice } from "./cookies";

afterEach(() => {
  document.cookie = "wx_login_notice=; Path=/; Max-Age=0";
  document.cookie = "wx_drive_notice=; Path=/; Max-Age=0";
});

describe("consumeNotice", () => {
  test("Cookie の JSON を読んで、1回で消す", () => {
    const value = encodeURIComponent(
      JSON.stringify({ code: "not_allowed", email: "a@example.com" }),
    );
    document.cookie = `wx_login_notice=${value}; Path=/`;
    expect(consumeNotice("wx_login_notice")).toEqual({
      code: "not_allowed",
      email: "a@example.com",
    });
    expect(consumeNotice("wx_login_notice")).toBeNull();
  });

  test("Cookie が無い・壊れているときは null", () => {
    expect(consumeNotice("wx_drive_notice")).toBeNull();
    document.cookie = "wx_drive_notice=%7Bbroken; Path=/";
    expect(consumeNotice("wx_drive_notice")).toBeNull();
  });
});
