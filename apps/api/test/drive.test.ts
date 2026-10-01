import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { DriveError } from "../src/drive";
import { createTestContext, USERS } from "./helpers";

const ctx = createTestContext();
beforeEach(() => ctx.seed());
afterAll(() => ctx.close());

async function fileInfo(email: string | undefined, body: unknown) {
  return ctx.call("POST", "/api/drive/file-info", {
    cookie: email ? await ctx.login(email) : undefined,
    body,
  });
}

describe("POST /api/drive/file-info(ドライブの模擬)", () => {
  test("その人が登録した Google の資料は、シードの資料名・種別・更新日時を返す", async () => {
    const reply = await fileInfo(USERS.yamada, {
      url: "https://docs.google.com/presentation/d/seed-proposal-v2/edit#slide=id.p",
    });
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({
      fileId: "seed-proposal-v2",
      url: "https://docs.google.com/presentation/d/seed-proposal-v2/edit",
      name: "提案書 v2",
      kind: "google_slides",
      modifiedAt: "2026-09-21T01:00:00.000Z",
    });
  });

  test("fileId でも取れる", async () => {
    const reply = await fileInfo(USERS.sato, { fileId: "seed-survey" });
    expect(reply.status).toBe(200);
    expect(reply.json).toMatchObject({ name: "調査レポート", kind: "google_doc" });
  });

  test("ほかの人が登録した資料は、まだ使えない(422 DRIVE_FILE_NOT_ACCESSIBLE)。選んだ後は使える", async () => {
    const before = await fileInfo(USERS.yamada, { fileId: "seed-survey" });
    expect(before.status).toBe(422);
    expect(before.json.error).toMatchObject({
      code: "DRIVE_FILE_NOT_ACCESSIBLE",
      details: { fileId: "seed-survey" },
    });
    // 失敗として扱わない(連携の状態は変えない)
    expect(
      (await ctx.call("GET", "/api/me", { cookie: await ctx.login(USERS.yamada) })).json.drive
        .status,
    ).toBe("active");
    ctx.mockDrive.grant(await ctx.userId(USERS.yamada), "seed-survey");
    expect((await fileInfo(USERS.yamada, { fileId: "seed-survey" })).status).toBe(200);
    // 使えるようになるのは選んだ本人だけ
    expect((await fileInfo(USERS.sato, { fileId: "seed-proposal-v1" })).status).toBe(200);
    expect((await fileInfo(USERS.yamada, { fileId: "seed-proposal-v1" })).status).toBe(422);
  });

  test("シードにも無いファイルは使えない", async () => {
    const reply = await fileInfo(USERS.yamada, { fileId: "unknown-file" });
    expect(reply.status).toBe(422);
    expect(reply.json.error.code).toBe("DRIVE_FILE_NOT_ACCESSIBLE");
  });

  test("要再連携の人(田中)は 409 DRIVE_REAUTH_REQUIRED(Drive は呼ばない)", async () => {
    let called = false;
    const spy = createTestContext(
      {},
      {
        drive: () => ({
          async getFile() {
            called = true;
            throw new DriveError("unavailable");
          },
        }),
      },
    );
    try {
      const cookie = await spy.login(USERS.tanaka);
      const reply = await spy.call("POST", "/api/drive/file-info", {
        cookie,
        body: { fileId: "seed-template" },
      });
      expect(reply.status).toBe(409);
      expect(reply.json.error.code).toBe("DRIVE_REAUTH_REQUIRED");
      expect(called).toBe(false);
    } finally {
      await spy.close();
    }
    const tanaka = await fileInfo(USERS.tanaka, { fileId: "seed-template" });
    expect(tanaka.status).toBe(409);
  });

  test("Drive が認可エラーを返したら、連携を要再連携にして 409 を返す", async () => {
    const failing = createTestContext(
      {},
      {
        drive: () => ({
          async getFile() {
            throw new DriveError("reauth");
          },
        }),
      },
    );
    try {
      const cookie = await failing.login(USERS.yamada);
      const reply = await failing.call("POST", "/api/drive/file-info", {
        cookie,
        body: { fileId: "x" },
      });
      expect(reply.status).toBe(409);
      expect(reply.json.error.code).toBe("DRIVE_REAUTH_REQUIRED");
      const [connection] = await failing.db
        .select()
        .from(schema.driveConnections)
        .where(eq(schema.driveConnections.userId, await failing.userId(USERS.yamada)));
      expect(connection?.status).toBe("needs_reauth");
      // 切り替わったときの1回だけ記録する(05 1章)
      const second = await failing.call("POST", "/api/drive/file-info", {
        cookie,
        body: { fileId: "x" },
      });
      expect(second.status).toBe(409);
      const logged = failing.logs.filter((l) => l.event === "drive_reauth_required");
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({
        severity: "WARN",
        userId: await failing.userId(USERS.yamada),
      });
    } finally {
      await failing.seed();
      await failing.close();
    }
  });

  test("一時的な失敗は 503 SERVICE_UNAVAILABLE で、要再連携にしない", async () => {
    const failing = createTestContext(
      {},
      {
        drive: () => ({
          async getFile() {
            throw new DriveError("unavailable");
          },
        }),
      },
    );
    try {
      const cookie = await failing.login(USERS.yamada);
      const reply = await failing.call("POST", "/api/drive/file-info", {
        cookie,
        body: { fileId: "x" },
      });
      expect(reply.status).toBe(503);
      expect(reply.json.error.code).toBe("SERVICE_UNAVAILABLE");
      const me = await failing.call("GET", "/api/me", { cookie });
      expect(me.json.drive.status).toBe("active");
    } finally {
      await failing.close();
    }
  });

  test("ドライブの資料でない URL・不正な入力は 422 VALIDATION_FAILED、未認証は 401", async () => {
    const cases: [unknown, Record<string, string>][] = [
      [{ url: "https://example.com/report.pdf" }, { url: "invalid_url" }],
      [{ url: "https://docs.google.com/document/d/e/2PACX-abc/pub" }, { url: "invalid_url" }],
      [{ url: "javascript:alert(1)" }, { url: "invalid_url" }],
      [{ url: "   " }, { url: "required" }],
      [{ fileId: "a/b" }, { fileId: "invalid_format" }],
      [{}, { url: "invalid_format" }],
      [
        { url: "https://docs.google.com/document/d/a/edit", fileId: "a" },
        { fileId: "invalid_format" },
      ],
    ];
    for (const [body, fields] of cases) {
      const reply = await fileInfo(USERS.yamada, body);
      expect([JSON.stringify(body), reply.status]).toEqual([JSON.stringify(body), 422]);
      expect(reply.json.error.details.fields).toEqual(fields);
    }
    expect((await fileInfo(undefined, { fileId: "seed-survey" })).status).toBe(401);
  });
});
