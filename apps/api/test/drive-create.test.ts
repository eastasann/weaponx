import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { type Drive, DriveError } from "../src/drive";
import { createTestContext, type TestContext, USERS } from "./helpers";

const ctx = createTestContext();
const extra: TestContext[] = [];
beforeEach(() => ctx.seed());
afterAll(async () => {
  await ctx.close();
  for (const c of extra) await c.close();
});

/** `drive` で差し替えたメソッドだけ上書きした、もう1つの API(同じ DB を使う) */
function withDrive(override: (mock: TestContext["mockDrive"]) => Partial<Drive>): TestContext {
  const c = createTestContext({}, { drive: override });
  extra.push(c);
  return c;
}

const fail = (reason: "reauth" | "not_accessible" | "unavailable") => async (): Promise<never> => {
  throw new DriveError(reason);
};

async function referencesOf(documentId: string): Promise<string[]> {
  const rows = await ctx.db
    .select({ id: schema.documentReferences.referencedDocumentId })
    .from(schema.documentReferences)
    .where(eq(schema.documentReferences.documentId, documentId));
  return rows.map((r) => r.id).sort();
}

async function rowOf(documentId: string) {
  const [row] = await ctx.db
    .select()
    .from(schema.documents)
    .where(eq(schema.documents.id, documentId));
  if (!row) throw new Error("版がありません");
  return row;
}

async function countSeries(projectName: string): Promise<number> {
  const rows = await ctx.db
    .select()
    .from(schema.documentSeries)
    .where(eq(schema.documentSeries.projectId, await ctx.projectId(projectName)));
  return rows.length;
}

describe("POST /api/series/:seriesId/versions/copy(新しい版を作る)", () => {
  test("提案書の最新版から v4 ができる。参考資料は引き継ぎ、タグは引き継がない", async () => {
    const cookie = await ctx.login(USERS.yamada);
    const series = await ctx.seriesId("提案書 v3");
    const v3 = await ctx.documentId("提案書 v3");
    const reply = await ctx.call("POST", `/api/series/${series}/versions/copy`, {
      cookie,
      body: { sourceDocumentId: v3, name: "提案書 v4", changeNote: "価格を更新" },
    });
    expect(reply.status).toBe(201);
    const { document, series: row, editUrl } = reply.json;
    expect(document).toMatchObject({
      versionNo: 4,
      isLatest: true,
      name: "提案書 v4",
      kind: "google_slides",
      changeNote: "価格を更新",
      tags: [],
      nameLocked: true,
      registeredBy: { email: USERS.yamada },
    });
    expect(editUrl).toBe(document.url);
    expect(document.url).toMatch(/^https:\/\/docs\.google\.com\/presentation\/d\/[\w-]+\/edit$/);
    expect(document.googleFileId).not.toBeNull();
    expect(row.latest.id).toBe(document.id);
    expect(row.olderCount).toBe(3);
    expect(await referencesOf(document.id)).toEqual(await referencesOf(v3));
    expect((await referencesOf(document.id)).length).toBeGreaterThan(0);
    const stored = await rowOf(document.id);
    expect(stored.createdVia).toBe("copied");
    expect(stored.metadataFetchedAt).not.toBeNull();
    // 作った人は、作ったファイルをアプリで使える
    const info = await ctx.call("POST", "/api/drive/file-info", {
      cookie,
      body: { fileId: document.googleFileId },
    });
    expect(info.status).toBe(200);
    expect(info.json.name).toBe("提案書 v4");
  });

  test("案件の最終更新が進む", async () => {
    const cookie = await ctx.login(USERS.yamada);
    const project = await ctx.projectId("A社 DX提案");
    const series = await ctx.seriesId("提案書 v3");
    const before = Date.now();
    await ctx.call("POST", `/api/series/${series}/versions/copy`, {
      cookie,
      body: { sourceDocumentId: await ctx.documentId("提案書 v3"), name: "提案書 v4" },
    });
    const [p] = await ctx.db.select().from(schema.projects).where(eq(schema.projects.id, project));
    expect(p?.lastActivityAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  test("参考資料は、登録する時点の最新版から引き継ぐ(開いた後に新しい版が登録されていれば、その版)", async () => {
    const cookie = await ctx.login(USERS.yamada);
    const series = await ctx.seriesId("提案書 v3");
    const reference = await ctx.documentId("調査レポート");
    const registered = await ctx.call("POST", `/api/series/${series}/versions`, {
      cookie,
      body: {
        url: "https://example.com/v4",
        name: "提案書 v4",
        kind: "other",
        referenceIds: [reference],
      },
    });
    expect(registered.status).toBe(201);
    const copied = await ctx.call("POST", `/api/series/${series}/versions/copy`, {
      cookie,
      // ダイアログを開いたときの最新版は v3 だった
      body: { sourceDocumentId: await ctx.documentId("提案書 v3"), name: "提案書 v5" },
    });
    expect(copied.status).toBe(201);
    expect(copied.json.document.versionNo).toBe(5);
    expect(await referencesOf(copied.json.document.id)).toEqual([reference]);
  });

  test("同時に作ると、後から処理された側は次の番号で成功する", async () => {
    const cookie = await ctx.login(USERS.yamada);
    const series = await ctx.seriesId("提案書 v3");
    const v3 = await ctx.documentId("提案書 v3");
    const replies = await Promise.all(
      ["A", "B", "C"].map((name) =>
        ctx.call("POST", `/api/series/${series}/versions/copy`, {
          cookie,
          body: { sourceDocumentId: v3, name },
        }),
      ),
    );
    expect(replies.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(replies.map((r) => r.json.document.versionNo).sort()).toEqual([4, 5, 6]);
  });

  test("コピー元をアプリがまだ使えなければ 422 DRIVE_SOURCE_UNAVAILABLE。選んだ後は作れる", async () => {
    // v3 を登録したのは山田。佐藤はまだ使えない
    const cookie = await ctx.login(USERS.sato);
    const series = await ctx.seriesId("提案書 v3");
    const body = { sourceDocumentId: await ctx.documentId("提案書 v3"), name: "提案書 v4" };
    const before = await ctx.call("POST", `/api/series/${series}/versions/copy`, { cookie, body });
    expect(before.status).toBe(422);
    expect(before.json.error.code).toBe("DRIVE_SOURCE_UNAVAILABLE");
    ctx.mockDrive.grant(await ctx.userId(USERS.sato), "seed-proposal-v3");
    const after = await ctx.call("POST", `/api/series/${series}/versions/copy`, { cookie, body });
    expect(after.status).toBe(201);
    // 失敗した呼び出しは番号を消費しない
    expect(after.json.document.versionNo).toBe(4);
  });

  test("入力の不備は 422 VALIDATION_FAILED で、Drive には何も作らない", async () => {
    let created = 0;
    const spy = withDrive((mock) => ({
      async copyFile(userId, fileId, name) {
        created++;
        return mock.copyFile(userId, fileId, name);
      },
    }));
    const cookie = await spy.login(USERS.yamada);
    const series = await spy.seriesId("提案書 v3");
    const v3 = await spy.documentId("提案書 v3");
    const sheet = await spy.documentId("見積書");
    const cases: [unknown, Record<string, string>][] = [
      [{ sourceDocumentId: v3, name: "" }, { name: "required" }],
      [{ sourceDocumentId: v3, name: "あ".repeat(201) }, { name: "too_long" }],
      [
        { sourceDocumentId: v3, name: "x", changeNote: "あ".repeat(101) },
        { changeNote: "too_long" },
      ],
      [{ sourceDocumentId: "not-a-uuid", name: "x" }, { sourceDocumentId: "invalid_format" }],
    ];
    for (const [body, fields] of cases) {
      const reply = await spy.call("POST", `/api/series/${series}/versions/copy`, { cookie, body });
      expect(reply.status).toBe(422);
      expect(reply.json.error).toMatchObject({ code: "VALIDATION_FAILED", details: { fields } });
    }
    // ドキュメント・スライドでない版(別の系列の版でもある)はコピーできない
    const notInSeries = await spy.call("POST", `/api/series/${series}/versions/copy`, {
      cookie,
      body: { sourceDocumentId: sheet, name: "x" },
    });
    expect(notInSeries.status).toBe(404);
    expect(notInSeries.json.error.code).toBe("DOCUMENT_NOT_FOUND");
    const sheetSeries = await spy.seriesId("見積書");
    const sheetCopy = await spy.call("POST", `/api/series/${sheetSeries}/versions/copy`, {
      cookie,
      body: { sourceDocumentId: sheet, name: "x" },
    });
    expect(sheetCopy.status).toBe(422);
    expect(sheetCopy.json.error.details.fields).toEqual({ sourceDocumentId: "invalid_format" });
    expect(created).toBe(0);
  });

  test("削除済みの版はコピー元にできない(404 DOCUMENT_NOT_FOUND)", async () => {
    const cookie = await ctx.login(USERS.yamada);
    const series = await ctx.seriesId("提案書 v3");
    const v3 = await ctx.documentId("提案書 v3");
    await ctx.db
      .update(schema.documents)
      .set({ deletedAt: new Date(), deletedBy: await ctx.userId(USERS.yamada) })
      .where(eq(schema.documents.id, v3));
    const reply = await ctx.call("POST", `/api/series/${series}/versions/copy`, {
      cookie,
      body: { sourceDocumentId: v3, name: "x" },
    });
    expect(reply.status).toBe(404);
    expect(reply.json.error.code).toBe("DOCUMENT_NOT_FOUND");
  });
});

describe("POST /api/projects/:projectId/documents/new(新しく作る)", () => {
  test("新しい系列ができる(1版目・参考資料・登録の経路)", async () => {
    const cookie = await ctx.login(USERS.yamada);
    const project = await ctx.projectId("A社 DX提案");
    const reference = await ctx.documentId("調査レポート");
    const reply = await ctx.call("POST", `/api/projects/${project}/documents/new`, {
      cookie,
      body: { kind: "google_slides", name: "新規スライド", referenceIds: [reference] },
    });
    expect(reply.status).toBe(201);
    const { document, series, editUrl } = reply.json;
    expect(document).toMatchObject({
      versionNo: 1,
      name: "新規スライド",
      kind: "google_slides",
      nameLocked: true,
      tags: [],
      changeNote: null,
    });
    expect(series.latest.id).toBe(document.id);
    expect(series.olderCount).toBe(0);
    expect(editUrl).toMatch(/^https:\/\/docs\.google\.com\/presentation\/d\/[\w-]+\/edit$/);
    expect(await referencesOf(document.id)).toEqual([reference]);
    const stored = await rowOf(document.id);
    expect(stored.createdVia).toBe("created");
    expect(stored.registeredBy).toBe(await ctx.userId(USERS.yamada));
    // 一覧に出る
    const list = await ctx.call("GET", `/api/projects/${project}/series`, { cookie });
    expect(list.json.series.map((s: { id: string }) => s.id)).toContain(series.id);
  });

  test("ドキュメントも作れる。同じ資料名でも別のファイルになる", async () => {
    const cookie = await ctx.login(USERS.yamada);
    const project = await ctx.projectId("A社 DX提案");
    const body = { kind: "google_doc", name: "調査メモ" };
    const a = await ctx.call("POST", `/api/projects/${project}/documents/new`, { cookie, body });
    const b = await ctx.call("POST", `/api/projects/${project}/documents/new`, { cookie, body });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.json.document.kind).toBe("google_doc");
    expect(a.json.editUrl).toMatch(/\/document\/d\//);
    expect(a.json.document.googleFileId).not.toBe(b.json.document.googleFileId);
  });

  test("入力の不備は 422 で、Drive には何も作らない", async () => {
    let created = 0;
    const spy = withDrive((mock) => ({
      async createFile(userId, kind, name) {
        created++;
        return mock.createFile(userId, kind, name);
      },
    }));
    const cookie = await spy.login(USERS.yamada);
    const project = await spy.projectId("A社 DX提案");
    const deleted = await spy.documentId("見積書 v2");
    const cases: [unknown, number, string, unknown][] = [
      [{ kind: "google_sheets", name: "x" }, 422, "VALIDATION_FAILED", { kind: "invalid_format" }],
      [{ kind: "google_doc", name: "  " }, 422, "VALIDATION_FAILED", { name: "required" }],
      [
        { kind: "google_doc", name: "あ".repeat(201) },
        422,
        "VALIDATION_FAILED",
        { name: "too_long" },
      ],
      [{ kind: "google_doc" }, 422, "VALIDATION_FAILED", { name: "required" }],
      [
        { kind: "google_doc", name: "x", referenceIds: ["nope"] },
        422,
        "VALIDATION_FAILED",
        { referenceIds: "invalid_format" },
      ],
      [
        { kind: "google_doc", name: "x", referenceIds: [deleted] },
        422,
        "REFERENCE_UNAVAILABLE",
        undefined,
      ],
    ];
    for (const [body, status, code, fields] of cases) {
      const reply = await spy.call("POST", `/api/projects/${project}/documents/new`, {
        cookie,
        body,
      });
      expect([reply.status, reply.json.error.code]).toEqual([status, code]);
      if (fields) expect(reply.json.error.details.fields).toEqual(fields);
    }
    expect(created).toBe(0);
    expect(await countSeries("A社 DX提案")).toBe(5);
  });
});

describe("POST /api/documents/:documentId/copies(これを元に作る)", () => {
  test("追加先の案件に新しい系列ができ、参考資料にコピー元の版が入る(タグは付かない)", async () => {
    const cookie = await ctx.login(USERS.yamada);
    const v3 = await ctx.documentId("提案書 v3");
    const target = await ctx.projectId("B社 市場調査");
    const reply = await ctx.call("POST", `/api/documents/${v3}/copies`, {
      cookie,
      body: { targetProjectId: target, name: "提案書 v3 のコピー" },
    });
    expect(reply.status).toBe(201);
    const { projectId, document, series, editUrl } = reply.json;
    expect(projectId).toBe(target);
    expect(document).toMatchObject({
      projectId: target,
      versionNo: 1,
      name: "提案書 v3 のコピー",
      kind: "google_slides",
      tags: [],
      changeNote: null,
    });
    expect(series.latest.id).toBe(document.id);
    expect(editUrl).toBe(document.url);
    expect(await referencesOf(document.id)).toEqual([v3]);
    const stored = await rowOf(document.id);
    expect(stored.createdVia).toBe("copied");
    expect(stored.projectId).toBe(target);
  });

  test("今の案件にも追加できる", async () => {
    const cookie = await ctx.login(USERS.yamada);
    const reply = await ctx.call(
      "POST",
      `/api/documents/${await ctx.documentId("提案書 v2")}/copies`,
      {
        cookie,
        body: { targetProjectId: await ctx.projectId("A社 DX提案"), name: "コピー" },
      },
    );
    expect(reply.status).toBe(201);
    expect(reply.json.document.versionNo).toBe(1);
  });

  test("追加先に追加できなければ 422 TARGET_PROJECT_UNAVAILABLE(削除済み・閲覧者・不参加・存在しない)で、Drive は呼ばない", async () => {
    let copied = 0;
    const spy = withDrive((mock) => ({
      async copyFile(userId, fileId, name) {
        copied++;
        return mock.copyFile(userId, fileId, name);
      },
    }));
    const cookie = await spy.login(USERS.yamada);
    const v3 = await spy.documentId("提案書 v3");
    const targets = [
      await spy.projectId("C社 業務改善"), // 削除済み
      await spy.projectId("社内テンプレート集"), // 山田は閲覧者
      await spy.projectId("D社 研修企画"), // 山田は不参加
      crypto.randomUUID(),
    ];
    for (const targetProjectId of targets) {
      const reply = await spy.call("POST", `/api/documents/${v3}/copies`, {
        cookie,
        body: { targetProjectId, name: "x" },
      });
      expect([reply.status, reply.json.error.code]).toEqual([422, "TARGET_PROJECT_UNAVAILABLE"]);
    }
    expect(copied).toBe(0);
  });

  test("入力の不備・コピーできない版・使えないコピー元", async () => {
    const cookie = await ctx.login(USERS.yamada);
    const v3 = await ctx.documentId("提案書 v3");
    const target = await ctx.projectId("B社 市場調査");
    const bad = await ctx.call("POST", `/api/documents/${v3}/copies`, {
      cookie,
      body: { targetProjectId: "x", name: "" },
    });
    expect(bad.status).toBe(422);
    expect(bad.json.error.details.fields).toEqual({
      name: "required",
      targetProjectId: "invalid_format",
    });

    const sheet = await ctx.documentId("見積書");
    const notCopyable = await ctx.call("POST", `/api/documents/${sheet}/copies`, {
      cookie,
      body: { targetProjectId: target, name: "x" },
    });
    expect(notCopyable.status).toBe(422);
    expect(notCopyable.json.error.details.fields).toEqual({ documentId: "invalid_format" });

    // 佐藤が登録した調査レポートは、山田はまだ使えない
    const survey = await ctx.documentId("調査レポート");
    const unusable = await ctx.call("POST", `/api/documents/${survey}/copies`, {
      cookie,
      body: { targetProjectId: target, name: "x" },
    });
    expect([unusable.status, unusable.json.error.code]).toEqual([422, "DRIVE_SOURCE_UNAVAILABLE"]);
    expect(await countSeries("B社 市場調査")).toBe(2);
  });
});

describe("要再連携の利用者(田中)", () => {
  test("作成系のエンドポイントは 409 DRIVE_REAUTH_REQUIRED で、Drive は呼ばず何も作らない", async () => {
    let called = 0;
    const count = async (): Promise<never> => {
      called++;
      throw new DriveError("unavailable");
    };
    const spy = withDrive(() => ({
      getFile: count,
      createFile: count,
      copyFile: count,
      issuePickerToken: count,
    }));
    const cookie = await spy.login(USERS.tanaka);
    const project = await spy.projectId("B社 市場調査");
    const calls: [string, string, unknown][] = [
      ["POST", `/api/projects/${project}/documents/new`, { kind: "google_doc", name: "x" }],
      [
        "POST",
        `/api/series/${await spy.seriesId("競合比較")}/versions/copy`,
        { sourceDocumentId: await spy.documentId("競合比較"), name: "x" },
      ],
      [
        "POST",
        `/api/documents/${await spy.documentId("提案書(B社向け)")}/copies`,
        { targetProjectId: project, name: "x" },
      ],
      ["GET", `/api/documents/${await spy.documentId("提案書(B社向け)")}/drive-access`, undefined],
      ["POST", `/api/projects/${project}/metadata-refresh`, undefined],
      ["POST", "/api/drive/picker-token", undefined],
    ];
    for (const [method, path, body] of calls) {
      const reply = await spy.call(method, path, { cookie, body });
      expect([path, reply.status, reply.json.error.code]).toEqual([
        path,
        409,
        "DRIVE_REAUTH_REQUIRED",
      ]);
    }
    expect(called).toBe(0);
    expect(await countSeries("B社 市場調査")).toBe(2);
  });
});

describe("Drive の失敗", () => {
  test("作成・コピーの失敗は 502 DRIVE_CREATE_FAILED(何も登録しない)", async () => {
    const spy = withDrive(() => ({
      createFile: fail("unavailable"),
      copyFile: fail("unavailable"),
    }));
    const cookie = await spy.login(USERS.yamada);
    const project = await spy.projectId("A社 DX提案");
    const v3 = await spy.documentId("提案書 v3");
    const calls: [string, unknown][] = [
      [`/api/projects/${project}/documents/new`, { kind: "google_doc", name: "x" }],
      [
        `/api/series/${await spy.seriesId("提案書 v3")}/versions/copy`,
        { sourceDocumentId: v3, name: "x" },
      ],
      [`/api/documents/${v3}/copies`, { targetProjectId: project, name: "x" }],
    ];
    for (const [path, body] of calls) {
      const reply = await spy.call("POST", path, { cookie, body });
      expect([path, reply.status, reply.json.error.code]).toEqual([
        path,
        502,
        "DRIVE_CREATE_FAILED",
      ]);
    }
    expect(await countSeries("A社 DX提案")).toBe(5);
    const [series] = await spy.db
      .select()
      .from(schema.documentSeries)
      .where(eq(schema.documentSeries.id, await spy.seriesId("提案書 v3")));
    expect(series?.nextVersionNo).toBe(4);
  });

  test("新しく作るときの not_accessible は元のファイルの問題ではないので DRIVE_CREATE_FAILED", async () => {
    const spy = withDrive(() => ({ createFile: fail("not_accessible") }));
    const reply = await spy.call(
      "POST",
      `/api/projects/${await spy.projectId("A社 DX提案")}/documents/new`,
      { cookie: await spy.login(USERS.yamada), body: { kind: "google_doc", name: "x" } },
    );
    expect([reply.status, reply.json.error.code]).toEqual([502, "DRIVE_CREATE_FAILED"]);
  });

  test("Drive の認可エラーは 409 DRIVE_REAUTH_REQUIRED にして、連携を要再連携にする", async () => {
    const spy = withDrive(() => ({ createFile: fail("reauth") }));
    const cookie = await spy.login(USERS.yamada);
    const project = await spy.projectId("A社 DX提案");
    const reply = await spy.call("POST", `/api/projects/${project}/documents/new`, {
      cookie,
      body: { kind: "google_doc", name: "x" },
    });
    expect([reply.status, reply.json.error.code]).toEqual([409, "DRIVE_REAUTH_REQUIRED"]);
    const me = await spy.call("GET", "/api/me", { cookie });
    expect(me.json.drive.status).toBe("needs_reauth");
  });
});

describe("Drive には作れたが登録できなかったとき(DRIVE_CREATED_NOT_REGISTERED)", () => {
  const created = (fileId: string) => ({
    fileId,
    name: "作成したファイル",
    kind: "google_doc" as const,
    modifiedAt: new Date("2026-10-01T00:00:00Z"),
    url: `https://docs.google.com/document/d/${fileId}/edit`,
  });

  test("案件が見つからなくなった → 404(cause: not_found)。作ったファイルの情報を返す", async () => {
    const spy = withDrive(() => ({
      async createFile() {
        // 確認の後、登録の前に案件が削除された
        await spy.db
          .update(schema.projects)
          .set({ deletedAt: new Date() })
          .where(eq(schema.projects.id, await spy.projectId("A社 DX提案")));
        return created("made-1");
      },
    }));
    const cookie = await spy.login(USERS.yamada);
    const reply = await spy.call(
      "POST",
      `/api/projects/${await spy.projectId("A社 DX提案")}/documents/new`,
      { cookie, body: { kind: "google_doc", name: "x" } },
    );
    expect(reply.status).toBe(404);
    expect(reply.json.error).toMatchObject({
      code: "DRIVE_CREATED_NOT_REGISTERED",
      details: {
        file: { fileId: "made-1", url: "https://docs.google.com/document/d/made-1/edit" },
        cause: "not_found",
        causeCode: "PROJECT_NOT_FOUND",
      },
    });
  });

  test("役割が足りなくなった → 403(cause: forbidden)", async () => {
    const spy = withDrive(() => ({
      async copyFile() {
        await spy.db
          .update(schema.projectMembers)
          .set({ role: "viewer" })
          .where(eq(schema.projectMembers.userId, await spy.userId(USERS.yamada)));
        return created("made-2");
      },
    }));
    const cookie = await spy.login(USERS.yamada);
    const reply = await spy.call(
      "POST",
      `/api/series/${await spy.seriesId("提案書 v3")}/versions/copy`,
      { cookie, body: { sourceDocumentId: await spy.documentId("提案書 v3"), name: "x" } },
    );
    expect(reply.status).toBe(403);
    expect(reply.json.error.details).toMatchObject({
      file: { fileId: "made-2" },
      cause: "forbidden",
      causeCode: "ROLE_INSUFFICIENT",
    });
  });

  test("通信・その他の失敗 → 500(cause: internal)。登録は残らず、版番号も使われない", async () => {
    // 案件にすでにあるファイル ID を返させ、登録で一意制約に違反させる
    const spy = withDrive(() => ({
      async copyFile() {
        return created("seed-proposal-v1");
      },
    }));
    const cookie = await spy.login(USERS.yamada);
    const series = await spy.seriesId("提案書 v3");
    const secretName = `秘密の資料名-${crypto.randomUUID()}`;
    const reply = await spy.call("POST", `/api/series/${series}/versions/copy`, {
      cookie,
      body: { sourceDocumentId: await spy.documentId("提案書 v3"), name: secretName },
    });
    expect(reply.status).toBe(500);
    expect(reply.json.error).toMatchObject({
      code: "DRIVE_CREATED_NOT_REGISTERED",
      details: { file: { fileId: "seed-proposal-v1" }, cause: "internal", causeCode: "INTERNAL" },
    });
    const [row] = await spy.db
      .select()
      .from(schema.documentSeries)
      .where(eq(schema.documentSeries.id, series));
    expect(row?.nextVersionNo).toBe(4);
    // 資料名はログに出ない(原因のエラーのログにも)
    const logged = JSON.stringify(spy.logs);
    expect(logged).toContain("unhandled_error");
    expect(logged).not.toContain(secretName);
  });
});

describe("GET /api/documents/:documentId/drive-access", () => {
  test("使えるなら true、まだ使えなければ false(失敗にしない)。選ぶと true になる", async () => {
    const cookie = await ctx.login(USERS.yamada);
    const mine = await ctx.documentId("提案書 v3");
    const ok = await ctx.call("GET", `/api/documents/${mine}/drive-access`, { cookie });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ accessible: true, fileId: "seed-proposal-v3" });

    const sato = await ctx.login(USERS.sato);
    const before = await ctx.call("GET", `/api/documents/${mine}/drive-access`, { cookie: sato });
    expect(before.json).toEqual({ accessible: false, fileId: "seed-proposal-v3" });
    ctx.mockDrive.grant(await ctx.userId(USERS.sato), "seed-proposal-v3");
    const after = await ctx.call("GET", `/api/documents/${mine}/drive-access`, { cookie: sato });
    expect(after.json.accessible).toBe(true);
    // まだ使えないことは連携の状態を変えない
    expect((await ctx.call("GET", "/api/me", { cookie: sato })).json.drive.status).toBe("active");
  });

  test("ドキュメント・スライドでない版は 422 VALIDATION_FAILED", async () => {
    const cookie = await ctx.login(USERS.yamada);
    for (const name of ["見積書", "議事録 9/15", "業界ニュースまとめ"]) {
      const reply = await ctx.call(
        "GET",
        `/api/documents/${await ctx.documentId(name)}/drive-access`,
        { cookie },
      );
      expect([name, reply.status, reply.json.error.code]).toEqual([name, 422, "VALIDATION_FAILED"]);
    }
  });

  test("Drive の一時的な失敗は 503", async () => {
    const spy = withDrive(() => ({ getFile: fail("unavailable") }));
    const reply = await spy.call(
      "GET",
      `/api/documents/${await spy.documentId("提案書 v3")}/drive-access`,
      {
        cookie: await spy.login(USERS.yamada),
      },
    );
    expect([reply.status, reply.json.error.code]).toEqual([503, "SERVICE_UNAVAILABLE"]);
  });
});

describe("POST /api/drive/picker-token", () => {
  test("短命のトークンと期限を返す", async () => {
    const reply = await ctx.call("POST", "/api/drive/picker-token", {
      cookie: await ctx.login(USERS.yamada),
    });
    expect(reply.status).toBe(200);
    expect(reply.headers.get("cache-control")).toBe("no-store");
    expect(typeof reply.json.accessToken).toBe("string");
    expect(new Date(reply.json.expiresAt).getTime()).toBeGreaterThan(Date.now());
    // トークンはログに出ない
    expect(JSON.stringify(ctx.logs)).not.toContain(reply.json.accessToken);
  });

  test("Drive の認可エラーは 409 にして連携を要再連携にする", async () => {
    const spy = withDrive(() => ({ issuePickerToken: fail("reauth") }));
    const cookie = await spy.login(USERS.yamada);
    const reply = await spy.call("POST", "/api/drive/picker-token", { cookie });
    expect([reply.status, reply.json.error.code]).toEqual([409, "DRIVE_REAUTH_REQUIRED"]);
    expect((await spy.call("GET", "/api/me", { cookie })).json.drive.status).toBe("needs_reauth");
  });
});

describe("POST /api/dev/drive/grant(ドライブの模擬)", () => {
  test("選んだファイルが使えるようになる", async () => {
    const cookie = await ctx.login(USERS.yamada);
    const info = () =>
      ctx.call("POST", "/api/drive/file-info", { cookie, body: { fileId: "seed-survey" } });
    expect((await info()).status).toBe(422);
    const grant = await ctx.call("POST", "/api/dev/drive/grant", {
      cookie,
      body: { fileId: "seed-survey" },
    });
    expect(grant.status).toBe(204);
    expect((await info()).status).toBe(200);
  });

  test("版の無いファイルは 404、形式が違えば 422、ログインしていなければ 401", async () => {
    const cookie = await ctx.login(USERS.yamada);
    const unknown = await ctx.call("POST", "/api/dev/drive/grant", {
      cookie,
      body: { fileId: "no-such-file" },
    });
    expect([unknown.status, unknown.json.error.code]).toEqual([404, "NOT_FOUND"]);
    const bad = await ctx.call("POST", "/api/dev/drive/grant", {
      cookie,
      body: { fileId: "a b/c" },
    });
    expect([bad.status, bad.json.error.details.fields]).toEqual([
      422,
      { fileId: "invalid_format" },
    ]);
    const anon = await ctx.call("POST", "/api/dev/drive/grant", {
      body: { fileId: "seed-survey" },
    });
    expect(anon.status).toBe(401);
  });
});

test("DRIVE_MODE が mock でなければ、POST /api/dev/drive/grant のルートを登録しない", async () => {
  const google = createTestContext({
    DRIVE_MODE: "google",
    GOOGLE_PICKER_API_KEY: "test-key",
    GOOGLE_PROJECT_NUMBER: "123456789",
  });
  extra.push(google);
  const reply = await google.call("POST", "/api/dev/drive/grant", {
    cookie: await google.login(USERS.yamada),
    body: { fileId: "seed-survey" },
  });
  expect([reply.status, reply.json.error.code]).toEqual([404, "NOT_FOUND"]);
  // ファイルを選んだことにされていない
  const info = await google.call("POST", "/api/drive/file-info", {
    cookie: await google.login(USERS.yamada),
    body: { fileId: "seed-survey" },
  });
  expect(info.status).toBe(422);
});

describe("POST /api/projects/:projectId/metadata-refresh", () => {
  const later = new Date("2026-10-02T03:00:00Z");

  /** 取り直し先の Drive: 提案書 v3 だけ資料名と更新日時が変わっている */
  function changedDrive(calls: string[]) {
    return withDrive((mock) => ({
      async getFile(userId, fileId) {
        calls.push(fileId);
        const file = await mock.getFile(userId, fileId);
        return fileId === "seed-proposal-v3"
          ? { ...file, name: "提案書 v3(改)", modifiedAt: later }
          : file;
      },
    }));
  }

  test("使えるドライブの資料の最新版だけを取り直し、変わった系列を返す", async () => {
    const calls: string[] = [];
    const spy = changedDrive(calls);
    const cookie = await spy.login(USERS.yamada);
    const project = await spy.projectId("A社 DX提案");
    const series = await spy.seriesId("提案書 v3");
    const reply = await spy.call("POST", `/api/projects/${project}/metadata-refresh`, { cookie });
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ updatedSeriesIds: [series] });
    // 旧版・ドライブでない資料・削除済みは対象外。調査レポート(佐藤が登録)は呼ぶが、まだ使えない
    expect(calls.sort()).toEqual(["seed-estimate-v3", "seed-proposal-v3", "seed-survey"]);

    const detail = await spy.call("GET", `/api/series/${series}`, { cookie });
    expect(detail.json.versions[0]).toMatchObject({
      name: "提案書 v3(改)",
      sourceModifiedAt: later.toISOString(),
      modifiedAt: later.toISOString(),
      nameLocked: true,
    });
    // 更新日時が新しくなったので、案件の最終更新も進む
    const [p] = await spy.db.select().from(schema.projects).where(eq(schema.projects.id, project));
    expect(p?.lastActivityAt.toISOString()).toBe(later.toISOString());
    // 検索は新しい名前で当たる
    const found = await spy.call("GET", `/api/search?q=${encodeURIComponent("v3(改)")}`, {
      cookie,
    });
    expect(found.json.results).toHaveLength(1);
  });

  test("10分以内に取得済みの版は飛ばす(2回目は Drive を呼ばない)", async () => {
    const calls: string[] = [];
    const spy = changedDrive(calls);
    const cookie = await spy.login(USERS.yamada);
    const project = await spy.projectId("A社 DX提案");
    await spy.call("POST", `/api/projects/${project}/metadata-refresh`, { cookie });
    const first = calls.length;
    const second = await spy.call("POST", `/api/projects/${project}/metadata-refresh`, { cookie });
    expect(second.json).toEqual({ updatedSeriesIds: [] });
    // 取得できた2件は飛ばす。まだ使えない調査レポートだけ、もう一度呼ぶ
    expect(calls.slice(first)).toEqual(["seed-survey"]);
  });

  test("取得の記録が無い版は、値が同じでも取得済みにして返す(資料名が読み取り専用になる)", async () => {
    const estimate = await ctx.documentId("見積書");
    const before = await rowOf(estimate);
    const modifiedAt = before.sourceModifiedAt;
    if (!modifiedAt) throw new Error("シードの見積書 v3 は更新日時を持つはず");
    await ctx.db
      .update(schema.documents)
      .set({ metadataFetchedAt: null })
      .where(eq(schema.documents.id, estimate));
    // 版の値は変わらない Drive(取得の記録が無いと模擬はそのファイルを知らないので差し替える)
    const spy = withDrive(() => ({
      async getFile(_userId, fileId) {
        return {
          fileId,
          name: before.name,
          kind: before.kind,
          modifiedAt,
          url: before.url,
        };
      },
    }));
    const cookie = await spy.login(USERS.yamada);
    const project = await spy.projectId("A社 DX提案");
    const reply = await spy.call("POST", `/api/projects/${project}/metadata-refresh`, { cookie });
    expect(reply.json.updatedSeriesIds).toContain(await spy.seriesId("見積書"));
    expect((await rowOf(estimate)).metadataFetchedAt).not.toBeNull();
  });

  test("Drive の認可エラーは 409 にして連携を要再連携にする。一時的な失敗は黙って飛ばす", async () => {
    const reauth = withDrive(() => ({ getFile: fail("reauth") }));
    const cookie = await reauth.login(USERS.yamada);
    const project = await reauth.projectId("A社 DX提案");
    const reply = await reauth.call("POST", `/api/projects/${project}/metadata-refresh`, {
      cookie,
    });
    expect([reply.status, reply.json.error.code]).toEqual([409, "DRIVE_REAUTH_REQUIRED"]);
    expect((await reauth.call("GET", "/api/me", { cookie })).json.drive.status).toBe(
      "needs_reauth",
    );

    await ctx.seed();
    const flaky = withDrive(() => ({ getFile: fail("unavailable") }));
    const ok = await flaky.call(
      "POST",
      `/api/projects/${await flaky.projectId("A社 DX提案")}/metadata-refresh`,
      {
        cookie: await flaky.login(USERS.yamada),
      },
    );
    expect([ok.status, ok.json]).toEqual([200, { updatedSeriesIds: [] }]);
  });

  test("Drive への同時の呼び出しは5件まで", async () => {
    let inFlight = 0;
    let peak = 0;
    const spy = withDrive(() => ({
      async getFile(_userId, fileId) {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await Bun.sleep(20);
        inFlight--;
        return {
          fileId,
          name: `取得した ${fileId}`,
          kind: "google_doc",
          modifiedAt: new Date("2026-09-01T00:00:00Z"),
          url: `https://docs.google.com/document/d/${fileId}/edit`,
        };
      },
    }));
    const cookie = await spy.login(USERS.yamada);
    const project = await spy.projectId("A社 DX提案");
    for (let i = 0; i < 12; i++) {
      const reply = await spy.call("POST", `/api/projects/${project}/documents`, {
        cookie,
        body: {
          url: `https://docs.google.com/document/d/bulk-${i}/edit`,
          name: `一括 ${i}`,
          kind: "google_doc",
        },
      });
      expect(reply.status).toBe(201);
    }
    // 登録のときに取得した記録を消して、取り直しの対象にする
    await spy.db
      .update(schema.documents)
      .set({ metadataFetchedAt: null })
      .where(eq(schema.documents.projectId, project));
    peak = 0;
    const reply = await spy.call("POST", `/api/projects/${project}/metadata-refresh`, { cookie });
    expect(reply.status).toBe(200);
    expect(peak).toBe(5);
  });

  test("リンクが変わった版は上書きしない(取得の間の編集を消さない)", async () => {
    const estimate = await ctx.documentId("見積書");
    const spy = withDrive((mock) => ({
      async getFile(userId, fileId) {
        const file = await mock.getFile(userId, fileId);
        if (fileId === "seed-estimate-v3") {
          await spy.db
            .update(schema.documents)
            .set({
              googleFileId: null,
              url: "https://example.com/changed",
              linkKey: "u:https://example.com/changed",
            })
            .where(eq(schema.documents.id, estimate));
        }
        return { ...file, name: "上書きされてはいけない名前" };
      },
    }));
    const cookie = await spy.login(USERS.yamada);
    await spy.call("POST", `/api/projects/${await spy.projectId("A社 DX提案")}/metadata-refresh`, {
      cookie,
    });
    expect((await rowOf(estimate)).name).toBe("見積書");
  });

  test("取得を始めた後に別の呼び出しが取得を記録した版は、古い取得結果で上書きしない", async () => {
    const proposal = await ctx.documentId("提案書 v3");
    const proposalSeries = await ctx.seriesId("提案書 v3");
    const spy = withDrive((mock) => ({
      async getFile(userId, fileId) {
        const file = await mock.getFile(userId, fileId);
        if (fileId === "seed-proposal-v3") {
          // 別の呼び出しが、より新しい値を取得して書いた
          await spy.db
            .update(schema.documents)
            .set({ name: "より新しい名前", metadataFetchedAt: new Date(Date.now() + 1000) })
            .where(eq(schema.documents.id, proposal));
        }
        return { ...file, name: "古い名前" };
      },
    }));
    const cookie = await spy.login(USERS.yamada);
    const reply = await spy.call(
      "POST",
      `/api/projects/${await spy.projectId("A社 DX提案")}/metadata-refresh`,
      { cookie },
    );
    expect(reply.status).toBe(200);
    expect((await rowOf(proposal)).name).toBe("より新しい名前");
    expect(reply.json.updatedSeriesIds).not.toContain(proposalSeries);
  });
});
