import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestContext } from "./helpers";

const ctx = createTestContext();
beforeAll(() => ctx.seed());
afterAll(() => ctx.close());

describe("共通の応答", () => {
  test("healthz は DB を見ずに版を返し、X-Request-Id とセキュリティヘッダーが付く", async () => {
    const reply = await ctx.call("GET", "/api/healthz");
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ status: "ok", version: "test" });
    expect(reply.headers.get("x-request-id")).toMatch(/^[0-9a-f]{32}$/);
    expect(reply.headers.get("x-content-type-options")).toBe("nosniff");
    expect(reply.headers.get("referrer-policy")).toBe("strict-origin");
    expect(reply.headers.get("strict-transport-security")).toContain("max-age");
    expect(reply.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(reply.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("X-Cloud-Trace-Context の先頭をリクエスト ID にする", async () => {
    const trace = "105445aa7843bc8bf206b12000100000";
    const reply = await ctx.call("GET", "/api/healthz", {
      headers: { "x-cloud-trace-context": `${trace}/1;o=1` },
    });
    expect(reply.headers.get("x-request-id")).toBe(trace);
  });

  test("エラーにも X-Request-Id とセキュリティヘッダーが付き、形式は error.code / message", async () => {
    const reply = await ctx.call("GET", "/api/me");
    expect(reply.status).toBe(401);
    expect(reply.json.error.code).toBe("UNAUTHENTICATED");
    expect(typeof reply.json.error.message).toBe("string");
    expect(reply.headers.get("x-request-id")).toBeTruthy();
    expect(reply.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("存在しないパスは 404 NOT_FOUND", async () => {
    const reply = await ctx.call("GET", "/api/nothing-here");
    expect(reply.status).toBe(404);
    expect(reply.json.error.code).toBe("NOT_FOUND");
  });

  test("readyz は DB に SELECT 1 して 200", async () => {
    const reply = await ctx.call("GET", "/api/readyz");
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ status: "ok" });
  });

  test("config は開発用ログインの有無・Picker・版を返す(認証不要)", async () => {
    const reply = await ctx.call("GET", "/api/config");
    expect(reply.json).toEqual({ devLogin: true, picker: null, version: "test" });
  });
});

describe("CSRF", () => {
  test("Origin が違う・無い状態を変えるリクエストは 403 CSRF_REJECTED", async () => {
    for (const origin of ["https://evil.example", null]) {
      const reply = await ctx.call("POST", "/api/dev/login", {
        origin,
        body: { email: "yamada@example.com" },
      });
      expect(reply.status).toBe(403);
      expect(reply.json.error.code).toBe("CSRF_REJECTED");
    }
  });

  test("本文が JSON でないリクエストは 403 CSRF_REJECTED", async () => {
    const reply = await ctx.call("POST", "/api/dev/login", {
      rawBody: "email=yamada@example.com",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(reply.status).toBe(403);
    expect(reply.json.error.code).toBe("CSRF_REJECTED");
  });

  test("GET は Origin を見ない", async () => {
    expect(
      (await ctx.call("GET", "/api/healthz", { headers: { origin: "https://x" } })).status,
    ).toBe(200);
  });
});

describe("入力の検証", () => {
  test("JSON が壊れていれば 422 VALIDATION_FAILED", async () => {
    const reply = await ctx.call("POST", "/api/dev/login", { rawBody: "{bad" });
    expect(reply.status).toBe(422);
    expect(reply.json.error.code).toBe("VALIDATION_FAILED");
  });

  test("必須の項目が無ければ fields に required を返し、値は返さない", async () => {
    const reply = await ctx.call("POST", "/api/dev/login", { body: {} });
    expect(reply.status).toBe(422);
    expect(reply.json.error.details.fields).toEqual({ email: "required" });
  });
});

describe("画面のエラーの受け取り", () => {
  test("検索パラメーターを落とし、長さを切って client_error を記録する。認証は要らない", async () => {
    ctx.logs.length = 0;
    const reply = await ctx.call("POST", "/api/client-errors", {
      body: {
        message: "m".repeat(600),
        stack: "s".repeat(5000),
        path: "/?q=秘密の検索語#hash",
      },
    });
    expect(reply.status).toBe(204);
    const entry = ctx.logs.find((l) => l.event === "client_error");
    expect(entry).toBeTruthy();
    expect(entry?.severity).toBe("ERROR");
    expect(entry?.message).toBe("client_error");
    expect(entry?.path).toBe("/");
    expect(entry?.clientMessage).toHaveLength(500);
    expect(entry?.clientStack).toHaveLength(4000);
    expect(entry?.stack_trace).toBeUndefined();
    expect(JSON.stringify(entry)).not.toContain("秘密");
  });

  test("セッションがあれば利用者 ID を記録する", async () => {
    const cookie = await ctx.login("yamada@example.com");
    ctx.logs.length = 0;
    await ctx.call("POST", "/api/client-errors", { cookie, body: { message: "x", path: "/" } });
    const entry = ctx.logs.find((l) => l.event === "client_error");
    expect(entry?.userId).toBe(await ctx.userId("yamada@example.com"));
  });
});

describe("リクエストのログ", () => {
  test("KPI の集計に使う userId と route(GET /api/projects/:projectId/series)が出る", async () => {
    const cookie = await ctx.login("yamada@example.com");
    ctx.logs.length = 0;
    const reply = await ctx.call(
      "GET",
      `/api/projects/${await ctx.projectId("A社 DX提案")}/series`,
      {
        cookie,
      },
    );
    expect(reply.status).toBe(200);
    const entry = ctx.logs.find((l) => l.event === "request");
    expect(entry).toMatchObject({ route: "GET /api/projects/:projectId/series", status: 200 });
    expect(entry?.userId).toBe(await ctx.userId("yamada@example.com"));
  });

  test("route はテンプレートで、ID・本文・メール・Cookie を含まない", async () => {
    const cookie = await ctx.login("yamada@example.com");
    const projectId = await ctx.projectId("A社 DX提案");
    ctx.logs.length = 0;
    await ctx.call("PATCH", `/api/projects/${projectId}`, {
      cookie,
      body: { name: "ひみつの案件名" },
    });
    const entry = ctx.logs.find((l) => l.event === "request");
    expect(entry).toMatchObject({
      severity: "INFO",
      route: "PATCH /api/projects/:projectId",
      status: 200,
    });
    expect(typeof entry?.durationMs).toBe("number");
    expect(entry?.userId).toBe(await ctx.userId("yamada@example.com"));
    const all = JSON.stringify(ctx.logs);
    for (const secret of [
      projectId,
      "ひみつ",
      "yamada@example.com",
      cookie.split("=")[1] as string,
    ]) {
      expect(all).not.toContain(secret);
    }
  });

  test("4xx は WARN で code を持ち、存在しないパスの route は unmatched", async () => {
    ctx.logs.length = 0;
    await ctx.call("GET", "/api/me");
    await ctx.call("GET", "/api/zzz");
    const [me, unknown] = ctx.logs.filter((l) => l.event === "request");
    expect(me).toMatchObject({
      severity: "WARN",
      route: "GET /api/me",
      status: 401,
      code: "UNAUTHENTICATED",
    });
    expect(unknown?.route).toBe("GET unmatched");
  });

  test("GCP_PROJECT_ID があれば logging.googleapis.com/trace を付ける", async () => {
    const withProject = createTestContext({ GCP_PROJECT_ID: "demo-project" });
    try {
      await withProject.call("GET", "/api/healthz", {
        headers: { "x-cloud-trace-context": "105445aa7843bc8bf206b12000100000/1" },
      });
      expect(withProject.logs[0]?.["logging.googleapis.com/trace"]).toBe(
        "projects/demo-project/traces/105445aa7843bc8bf206b12000100000",
      );
      ctx.logs.length = 0;
      await ctx.call("GET", "/api/healthz");
      expect(ctx.logs[0]?.["logging.googleapis.com/trace"]).toBeUndefined();
    } finally {
      await withProject.close();
    }
  });
});
