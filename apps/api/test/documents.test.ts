import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { DriveError, type DriveFailure } from "../src/drive";
import { createTestContext, type Json, USERS } from "./helpers";

const ctx = createTestContext();
beforeEach(() => ctx.seed());
afterAll(() => ctx.close());

const NEW_URL = "https://example.com/files/new.pdf";

async function post(email: string, path: string, body: unknown) {
  return ctx.call("POST", path, { cookie: await ctx.login(email), body });
}

async function patch(email: string, documentId: string, body: unknown) {
  return ctx.call("PATCH", `/api/documents/${documentId}`, {
    cookie: await ctx.login(email),
    body,
  });
}

async function register(email: string, project: string, body: Json) {
  return post(email, `/api/projects/${await ctx.projectId(project)}/documents`, body);
}

async function addVersion(email: string, name: string, body: Json) {
  return post(email, `/api/series/${await ctx.seriesId(name)}/versions`, body);
}

async function row(documentId: string) {
  const [doc] = await ctx.db
    .select()
    .from(schema.documents)
    .where(eq(schema.documents.id, documentId));
  return doc as typeof schema.documents.$inferSelect;
}

async function lastActivity(project: string): Promise<number> {
  const [p] = await ctx.db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, await ctx.projectId(project)));
  return (p as typeof schema.projects.$inferSelect).lastActivityAt.getTime();
}

describe("POST /api/projects/:projectId/documents", () => {
  test("リンクで登録すると新しい系列の v1 になり、案件の最終更新が進む", async () => {
    const before = await lastActivity("A社 DX提案");
    const reply = await register(USERS.sato, "A社 DX提案", {
      url: `  ${NEW_URL} `,
      name: "  新しい資料 ",
      kind: "pdf",
      sourceModifiedAt: "2026-09-19T15:00:00Z",
    });
    expect(reply.status).toBe(201);
    expect(reply.json.driveStatus).toBe("active");
    expect(reply.json.document).toMatchObject({
      versionNo: 1,
      isLatest: true,
      name: "新しい資料",
      url: NEW_URL,
      kind: "pdf",
      sourceModifiedAt: "2026-09-19T15:00:00.000Z",
      nameLocked: false,
      googleFileId: null,
      tags: [],
      registeredBy: { email: USERS.sato },
    });
    expect(reply.json.series).toMatchObject({ olderCount: 0, tags: [] });
    const saved = await row(reply.json.document.id);
    expect(saved).toMatchObject({
      createdVia: "link",
      nameKey: "新しい資料",
      linkKey: `u:${NEW_URL}`,
    });
    expect(await lastActivity("A社 DX提案")).toBeGreaterThan(before);
  });

  test("ドライブの資料で取り直せたら、資料名・更新日時・種類は Drive の値になる(送られた値は見ない)", async () => {
    // 調査レポート(A社・佐藤が登録)を、山田が B社 に登録する。山田はまだ使えないので、選んだことにする
    ctx.mockDrive.grant(await ctx.userId(USERS.yamada), "seed-survey");
    const reply = await register(USERS.yamada, "B社 市場調査", {
      url: "https://docs.google.com/document/d/seed-survey/edit",
      name: "手入力の名前",
      kind: "other",
      sourceModifiedAt: "2026-01-01T00:00:00Z",
    });
    expect(reply.status).toBe(201);
    expect(reply.json.driveStatus).toBe("active");
    expect(reply.json.document).toMatchObject({
      name: "調査レポート",
      kind: "google_doc",
      googleFileId: "seed-survey",
      nameLocked: true,
      sourceModifiedAt: "2026-09-20T01:00:00.000Z",
    });
    expect((await row(reply.json.document.id)).metadataFetchedAt).not.toBeNull();
  });

  test("Drive の名前が200文字を超えていても、取り直せたときは Drive の名前で登録できる", async () => {
    const long = "あ".repeat(250);
    const reply = await register(USERS.yamada, "B社 市場調査", {
      url: "https://docs.google.com/document/d/seed-survey/edit",
      name: "x",
      kind: "google_doc",
    });
    // seed-survey はまだ使えない(未選択)ので、手入力の値で登録される
    expect(reply.json.document.nameLocked).toBe(false);

    const fake = createTestContext(
      {},
      {
        drive: () => ({
          async getFile(_userId, fileId) {
            return {
              fileId,
              name: long,
              kind: "google_doc",
              modifiedAt: new Date("2026-09-01T00:00:00Z"),
              url: `https://docs.google.com/document/d/${fileId}/edit`,
            };
          },
        }),
      },
    );
    try {
      const cookie = await fake.login(USERS.yamada);
      const result = await fake.call(
        "POST",
        `/api/projects/${await fake.projectId("B社 市場調査")}/documents`,
        {
          cookie,
          body: {
            url: "https://docs.google.com/document/d/long-name/edit",
            name: long,
            kind: "google_doc",
          },
        },
      );
      expect(result.status).toBe(201);
      expect(result.json.document.name).toBe(long);
    } finally {
      await fake.close();
    }
  });

  test("アプリがまだ使えないファイルは、送られた値で登録できる(失敗にも要再連携にもしない)", async () => {
    const reply = await register(USERS.yamada, "B社 市場調査", {
      url: "https://docs.google.com/document/d/seed-survey/edit",
      name: "調査レポート(手入力)",
      kind: "google_doc",
    });
    expect(reply.status).toBe(201);
    expect(reply.json.driveStatus).toBe("active");
    expect(reply.json.document).toMatchObject({
      name: "調査レポート(手入力)",
      googleFileId: "seed-survey",
      nameLocked: false,
    });
  });

  test("要再連携の人は Drive を呼ばずに、送られた値で登録できる。driveStatus は needs_reauth", async () => {
    const reply = await register(USERS.tanaka, "B社 市場調査", {
      url: "https://docs.google.com/spreadsheets/d/typed/edit",
      name: "手入力",
      kind: "google_sheets",
    });
    expect(reply.status).toBe(201);
    expect(reply.json.driveStatus).toBe("needs_reauth");
    expect(reply.json.document).toMatchObject({ name: "手入力", nameLocked: false });
  });

  test("取り直しの途中で認可エラーになったら、登録は成功させて連携の状態を要再連携にする", async () => {
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
      await failing.seed();
      const cookie = await failing.login(USERS.yamada);
      const reply = await failing.call(
        "POST",
        `/api/projects/${await failing.projectId("B社 市場調査")}/documents`,
        {
          cookie,
          body: {
            url: "https://docs.google.com/document/d/abc/edit",
            name: "資料",
            kind: "google_doc",
          },
        },
      );
      expect(reply.status).toBe(201);
      expect(reply.json.driveStatus).toBe("needs_reauth");
      const me = await failing.call("GET", "/api/me", { cookie });
      expect(me.json.drive.status).toBe("needs_reauth");
    } finally {
      await failing.seed();
      await failing.close();
    }
  });

  for (const reason of ["unavailable", "not_accessible"] as DriveFailure[]) {
    test(`Drive が ${reason} でも、登録は成功し、連携の状態は変えない`, async () => {
      const failing = createTestContext(
        {},
        {
          drive: () => ({
            async getFile() {
              throw new DriveError(reason);
            },
          }),
        },
      );
      try {
        await failing.seed();
        const cookie = await failing.login(USERS.yamada);
        const reply = await failing.call(
          "POST",
          `/api/projects/${await failing.projectId("B社 市場調査")}/documents`,
          {
            cookie,
            body: {
              url: "https://docs.google.com/document/d/abc/edit",
              name: "資料",
              kind: "google_doc",
            },
          },
        );
        expect(reply.status).toBe(201);
        expect(reply.json.driveStatus).toBe("active");
      } finally {
        await failing.seed();
        await failing.close();
      }
    });
  }

  test("同じ案件の同じリンクは 409 DUPLICATE_LINK(既存の系列・版・名前を返す)", async () => {
    const reply = await register(USERS.yamada, "A社 DX提案", {
      url: "https://example.com/files/minutes-0915.pdf",
      name: "議事録のコピー",
      kind: "pdf",
    });
    expect(reply.status).toBe(409);
    expect(reply.json.error.code).toBe("DUPLICATE_LINK");
    expect(reply.json.error.details.existing).toEqual({
      seriesId: await ctx.seriesId("議事録 9/15"),
      documentId: await ctx.documentId("議事録 9/15"),
      name: "議事録 9/15",
    });
  });

  test("Google の資料はファイル ID で比べる(/u/0/ 付きの URL も同じ資料)", async () => {
    const reply = await register(USERS.yamada, "A社 DX提案", {
      url: "https://docs.google.com/presentation/u/0/d/seed-proposal-v3/edit?usp=sharing",
      name: "別名",
      kind: "google_slides",
    });
    expect(reply.status).toBe(409);
    expect(reply.json.error.details.existing.name).toBe("提案書 v3");
  });

  test("別の案件の同じリンク・削除済みの版と同じリンクは登録できる", async () => {
    const other = await register(USERS.yamada, "B社 市場調査", {
      url: "https://example.com/files/minutes-0915.pdf",
      name: "別の案件の議事録",
      kind: "pdf",
    });
    expect(other.status).toBe(201);
    // 見積書 v2 は削除済み
    const deleted = await register(USERS.yamada, "A社 DX提案", {
      url: "https://docs.google.com/spreadsheets/d/seed-estimate-v2/edit",
      name: "見積書 v2 再登録",
      kind: "google_sheets",
    });
    expect(deleted.status).toBe(201);
  });

  test("同じリンクの同時の登録は、片方だけが成功し、もう片方は 409 DUPLICATE_LINK", async () => {
    const results = await Promise.all(
      [1, 2, 3].map((n) =>
        register(USERS.yamada, "A社 DX提案", {
          url: "https://example.com/race",
          name: `競合 ${n}`,
          kind: "other",
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
  });

  test("入力の不備は 422 VALIDATION_FAILED で、欄ごとの理由を返す(すべての欄を調べる)", async () => {
    const reply = await register(USERS.yamada, "A社 DX提案", {
      url: "javascript:alert(1)",
      name: "あ".repeat(201),
      kind: "pdf",
      sourceModifiedAt: "2999-01-01T00:00:00Z",
      referenceIds: ["x"],
    });
    expect(reply.status).toBe(422);
    expect(reply.json.error.details.fields).toEqual({
      url: "invalid_url",
      name: "too_long",
      sourceModifiedAt: "future_date",
      referenceIds: "invalid_format",
    });
  });

  test("リンクが空・長すぎる・資料名が空・kind が不正", async () => {
    const cases: [Json, Json][] = [
      [{ url: " ", name: "a", kind: "pdf" }, { url: "required" }],
      [
        { url: `https://example.com/${"a".repeat(2048)}`, name: "a", kind: "pdf" },
        { url: "too_long" },
      ],
      [{ url: NEW_URL, name: "  ", kind: "pdf" }, { name: "required" }],
      [{ url: NEW_URL, name: "a\nb", kind: "pdf" }, { name: "invalid_format" }],
      [{ url: NEW_URL, name: "a", kind: "video" }, { kind: "invalid_format" }],
      [
        { url: NEW_URL, name: "a", kind: "pdf", sourceModifiedAt: "yesterday" },
        { sourceModifiedAt: "invalid_format" },
      ],
    ];
    for (const [body, fields] of cases) {
      const reply = await register(USERS.yamada, "A社 DX提案", body);
      expect(reply.status).toBe(422);
      expect(reply.json.error.details.fields).toEqual(fields);
    }
  });

  test("参考資料: 参加している案件の版は選べて、20件を超えると too_many。取り消し線の資料は REFERENCE_UNAVAILABLE", async () => {
    const ok = await register(USERS.yamada, "A社 DX提案", {
      url: NEW_URL,
      name: "参考つき",
      kind: "pdf",
      referenceIds: [
        await ctx.documentId("調査レポート"),
        await ctx.documentId("提案テンプレート"),
      ],
    });
    expect(ok.status).toBe(201);
    const refs = await ctx.db
      .select()
      .from(schema.documentReferences)
      .where(eq(schema.documentReferences.documentId, ok.json.document.id));
    expect(refs).toHaveLength(2);
    expect(refs[0]?.createdBy).toBe(await ctx.userId(USERS.yamada));

    const many = await register(USERS.yamada, "A社 DX提案", {
      url: "https://example.com/many",
      name: "多すぎ",
      kind: "pdf",
      referenceIds: Array.from({ length: 21 }, () => crypto.randomUUID()),
    });
    expect(many.status).toBe(422);
    expect(many.json.error.details.fields).toEqual({ referenceIds: "too_many" });

    const training = await ctx.documentId("研修カリキュラム"); // 山田は D社 に参加していない
    const deleted = await ctx.documentId("見積書 v2");
    const analysis = await ctx.documentId("現状分析"); // 案件ごと削除済み
    const unknown = crypto.randomUUID();
    const bad = await register(USERS.yamada, "A社 DX提案", {
      url: "https://example.com/bad",
      name: "不可",
      kind: "pdf",
      referenceIds: [training, deleted, analysis, unknown, await ctx.documentId("調査レポート")],
    });
    expect(bad.status).toBe(422);
    expect(bad.json.error.code).toBe("REFERENCE_UNAVAILABLE");
    expect(bad.json.error.details.documentIds.sort()).toEqual(
      [training, deleted, analysis, unknown].sort(),
    );
    // 失敗したときは何も作らない
    const created = await ctx.db
      .select()
      .from(schema.documents)
      .where(eq(schema.documents.name, "不可"));
    expect(created).toHaveLength(0);
  });
});

describe("POST /api/series/:seriesId/versions", () => {
  test("次の版番号で登録され、タグは引き継がない。参考資料は送った一式になる", async () => {
    const latestRefs = [
      await ctx.documentId("調査レポート"),
      await ctx.documentId("提案テンプレート"),
    ];
    const reply = await addVersion(USERS.sato, "提案書 v3", {
      url: "https://docs.google.com/presentation/d/new-v4/edit",
      name: "提案書 v4",
      kind: "google_slides",
      changeNote: "  価格を更新 ",
      referenceIds: latestRefs,
    });
    expect(reply.status).toBe(201);
    expect(reply.json.document).toMatchObject({
      versionNo: 4,
      isLatest: true,
      changeNote: "価格を更新",
      tags: [],
    });
    expect(reply.json.series.latest.id).toBe(reply.json.document.id);
    expect(reply.json.series.olderCount).toBe(3);
    // 旧版(v3)のタグ「確認済」は、最新版でなくなったので版番号つきになる
    expect(reply.json.series.tags).toContainEqual({ label: "確認済", versionNo: 3 });
  });

  test("最新版を削除した後の登録は、欠番を再利用せず次の番号になる", async () => {
    const cookie = await ctx.login(USERS.yamada);
    expect(
      (await ctx.call("DELETE", `/api/documents/${await ctx.documentId("提案書 v3")}`, { cookie }))
        .status,
    ).toBe(200);
    const reply = await addVersion(USERS.yamada, "提案書 v2", {
      url: "https://example.com/v4",
      name: "提案書 v4",
      kind: "other",
    });
    expect(reply.json.document.versionNo).toBe(4);
  });

  test("同時に登録しても版番号は重ならず、すべて成功する", async () => {
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        addVersion(n % 2 ? USERS.yamada : USERS.sato, "提案書 v3", {
          url: `https://example.com/concurrent-${n}`,
          name: `同時 ${n}`,
          kind: "other",
        }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    expect(results.map((r) => r.json.document.versionNo).sort()).toEqual([4, 5, 6, 7, 8]);
    const [series] = await ctx.db
      .select()
      .from(schema.documentSeries)
      .where(eq(schema.documentSeries.id, await ctx.seriesId("提案書 v3")));
    expect(series?.nextVersionNo).toBe(9);
  });

  test("引き継いだ参考資料は削除済みでもそのまま受け付け、新しく足した無効な資料だけを検証する", async () => {
    // 業界ニュースまとめの最新版の参考資料は、削除済みの案件の「現状分析」
    const analysis = await ctx.documentId("現状分析");
    const inherited = await addVersion(USERS.yamada, "業界ニュースまとめ", {
      url: "https://example.com/news/2",
      name: "業界ニュースまとめ 2",
      kind: "other",
      referenceIds: [analysis],
    });
    expect(inherited.status).toBe(201);

    const training = await ctx.documentId("研修カリキュラム");
    const bad = await addVersion(USERS.yamada, "業界ニュースまとめ", {
      url: "https://example.com/news/3",
      name: "業界ニュースまとめ 3",
      kind: "other",
      referenceIds: [training],
    });
    expect(bad.status).toBe(422);
    expect(bad.json.error).toMatchObject({
      code: "REFERENCE_UNAVAILABLE",
      details: { documentIds: [training] },
    });
  });

  test("同じ系列の版は参考資料にできない", async () => {
    const reply = await addVersion(USERS.yamada, "提案書 v3", {
      url: "https://example.com/self",
      name: "自己参照",
      kind: "other",
      referenceIds: [await ctx.documentId("提案書 v2")],
    });
    expect(reply.status).toBe(422);
    expect(reply.json.error.code).toBe("REFERENCE_UNAVAILABLE");
  });

  test("リンクの重複は 409。変更メモが長すぎると 422", async () => {
    const dup = await addVersion(USERS.yamada, "提案書 v3", {
      url: "https://docs.google.com/spreadsheets/d/seed-estimate-v3/edit",
      name: "x",
      kind: "google_sheets",
    });
    expect(dup.status).toBe(409);
    expect(dup.json.error.details.existing.name).toBe("見積書");
    const long = await addVersion(USERS.yamada, "提案書 v3", {
      url: "https://example.com/long-note",
      name: "x",
      kind: "other",
      changeNote: "あ".repeat(101),
    });
    expect(long.status).toBe(422);
    expect(long.json.error.details.fields).toEqual({ changeNote: "too_long" });
  });

  test("削除されていない版が無い系列には登録できない(404 DOCUMENT_NOT_FOUND)", async () => {
    const cookie = await ctx.login(USERS.yamada);
    const series = await ctx.seriesId("調査レポート");
    await ctx.call("DELETE", `/api/documents/${await ctx.documentId("調査レポート")}`, { cookie });
    const reply = await ctx.call("POST", `/api/series/${series}/versions`, {
      cookie,
      body: { url: NEW_URL, name: "x", kind: "pdf" },
    });
    expect(reply.status).toBe(404);
    expect(reply.json.error.code).toBe("DOCUMENT_NOT_FOUND");
  });
});

describe("PATCH /api/documents/:documentId", () => {
  test("変更メモを直し、送らなかった項目は変えない。空の変更メモは消す", async () => {
    const id = await ctx.documentId("提案書 v2");
    const reply = await patch(USERS.sato, id, { changeNote: " 数字を修正 " });
    expect(reply.status).toBe(200);
    expect(reply.json.document).toMatchObject({ changeNote: "数字を修正", name: "提案書 v2" });
    expect(reply.json.driveStatus).toBe("active");
    const cleared = await patch(USERS.sato, id, { changeNote: "" });
    expect(cleared.json.document.changeNote).toBeNull();
  });

  test("タグ: 消えたタグは行を消し、残るタグは位置を保って表記だけを直し、増えたタグは末尾に足す", async () => {
    const id = await ctx.documentId("提案書 初稿"); // タグ: 提出(1)、ドラフト(2)
    const reply = await patch(USERS.sato, id, {
      tags: ["ＤＲＡＦＴ", "ドラフト", "Final", "final"],
    });
    expect(reply.status).toBe(200);
    // 「ドラフト」は残り、全角の DRAFT と Final(final と重複)が増える。「提出」は消える
    expect(reply.json.document.tags).toEqual(["ドラフト", "ＤＲＡＦＴ", "Final"]);
    const rows = await ctx.db
      .select()
      .from(schema.documentTags)
      .where(eq(schema.documentTags.documentId, id))
      .orderBy(schema.documentTags.position);
    expect(rows.map((r) => [r.label, r.position])).toEqual([
      ["ドラフト", 2],
      ["ＤＲＡＦＴ", 3],
      ["Final", 4],
    ]);

    const relabeled = await patch(USERS.sato, id, { tags: ["FINAL", "ドラフト"] });
    expect(relabeled.json.document.tags).toEqual(["ドラフト", "FINAL"]);
    const after = await ctx.db
      .select()
      .from(schema.documentTags)
      .where(
        and(eq(schema.documentTags.documentId, id), eq(schema.documentTags.labelKey, "final")),
      );
    expect(after[0]).toMatchObject({ label: "FINAL", position: 4 });
  });

  test("タグは6件目で too_many、20文字を超えると too_long、空のタグは required", async () => {
    const id = await ctx.documentId("提案書 v2");
    const cases: [string[], string][] = [
      [["a", "b", "c", "d", "e", "f"], "too_many"],
      [["あ".repeat(21)], "too_long"],
      [[" "], "required"],
    ];
    for (const [tags, error] of cases) {
      const reply = await patch(USERS.sato, id, { tags });
      expect(reply.status).toBe(422);
      expect(reply.json.error.details.fields).toEqual({ tags: error });
    }
    expect((await patch(USERS.sato, id, { tags: ["a", "b", "c", "d", "e"] })).status).toBe(200);
    expect((await patch(USERS.sato, id, { tags: [] })).json.document.tags).toEqual([]);
  });

  test("同時にタグを足しても、保存した一式が5件を超えない(版の行ロック)", async () => {
    const id = await ctx.documentId("議事録 9/15");
    const results = await Promise.all(
      [1, 2, 3, 4].map((n) =>
        patch(USERS.sato, id, { tags: [`a${n}`, `b${n}`, `c${n}`, `d${n}`, `e${n}`] }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    const rows = await ctx.db
      .select()
      .from(schema.documentTags)
      .where(eq(schema.documentTags.documentId, id));
    expect(rows).toHaveLength(5);
  });

  test("Drive から名前を取得済みの版の資料名・更新日時は変えられない(422 locked)", async () => {
    const id = await ctx.documentId("提案書 v2");
    const reply = await patch(USERS.yamada, id, {
      name: "改名",
      sourceModifiedAt: "2026-09-01T00:00:00Z",
      changeNote: "メモ",
    });
    expect(reply.status).toBe(422);
    expect(reply.json.error.details.fields).toEqual({ name: "locked", sourceModifiedAt: "locked" });
    expect((await row(id)).name).toBe("提案書 v2");
    expect((await row(id)).changeNote).toBe("価格表を追加");
  });

  test("取得済みの版に不正な資料名を送っても、形式の不備より locked を返す", async () => {
    const reply = await patch(USERS.yamada, await ctx.documentId("提案書 v2"), {
      name: "",
      sourceModifiedAt: "yesterday",
    });
    expect(reply.status).toBe(422);
    expect(reply.json.error.details.fields).toEqual({ name: "locked", sourceModifiedAt: "locked" });
  });

  test("入力に不備のある依頼では、Drive を呼ばない", async () => {
    let calls = 0;
    const counting = createTestContext(
      {},
      {
        drive: () => ({
          async getFile() {
            calls++;
            throw new DriveError("unavailable");
          },
        }),
      },
    );
    try {
      const cookie = await counting.login(USERS.yamada);
      const reply = await counting.call(
        "POST",
        `/api/projects/${await counting.projectId("B社 市場調査")}/documents`,
        {
          cookie,
          body: {
            url: "https://docs.google.com/document/d/abc/edit",
            name: "資料",
            kind: "google_doc",
            referenceIds: ["x"],
          },
        },
      );
      expect(reply.status).toBe(422);
      expect(calls).toBe(0);
    } finally {
      await counting.close();
    }
  });

  test("取得済みでない版は、資料名と更新日時を変えられる(検索用の正規化も更新される)。null で更新日時を消す", async () => {
    const id = await ctx.documentId("議事録 9/15");
    const reply = await patch(USERS.sato, id, {
      name: " Ｍｉｎｕｔｅｓ ",
      sourceModifiedAt: "2026-09-16T00:00:00Z",
      kind: "other",
    });
    expect(reply.status).toBe(200);
    expect(reply.json.document).toMatchObject({
      name: "Ｍｉｎｕｔｅｓ",
      kind: "other",
      sourceModifiedAt: "2026-09-16T00:00:00.000Z",
    });
    expect((await row(id)).nameKey).toBe("minutes");
    const cleared = await patch(USERS.sato, id, { sourceModifiedAt: null });
    expect(cleared.json.document.sourceModifiedAt).toBeNull();
  });

  test("リンクを変えると取得済みの記録を消し、資料名と更新日時を編集できる状態に戻す", async () => {
    const id = await ctx.documentId("提案書 v2");
    const reply = await patch(USERS.yamada, id, {
      url: "https://example.com/replaced.pdf",
      name: "差し替え",
      kind: "pdf",
    });
    expect(reply.status).toBe(200);
    expect(reply.json.document).toMatchObject({
      name: "差し替え",
      kind: "pdf",
      googleFileId: null,
      nameLocked: false,
    });
    expect((await row(id)).linkKey).toBe("u:https://example.com/replaced.pdf");
    // 種別を送らなければリンクから判定し直す
    const again = await patch(USERS.yamada, id, {
      url: "https://docs.google.com/document/d/x1/edit",
    });
    expect(again.json.document.kind).toBe("google_doc");
    expect(again.json.document.name).toBe("差し替え");
  });

  test("リンクを使えるドライブの資料に変えたら、Drive の値で読み取り専用に戻る", async () => {
    ctx.mockDrive.grant(await ctx.userId(USERS.yamada), "seed-survey");
    const id = await ctx.documentId("提案書(B社向け)"); // B社 には調査レポートのリンクが無い
    const reply = await patch(USERS.yamada, id, {
      url: "https://docs.google.com/document/d/seed-survey/edit",
      name: "無視される",
    });
    expect(reply.status).toBe(200);
    expect(reply.json.document).toMatchObject({
      name: "調査レポート",
      kind: "google_doc",
      googleFileId: "seed-survey",
      nameLocked: true,
    });
  });

  test("リンクの変更が重複したら 409。同じ版のリンクを同じ値で送るのは重複にならない", async () => {
    const id = await ctx.documentId("見積書 v1");
    const dup = await patch(USERS.yamada, id, {
      url: "https://example.com/files/minutes-0915.pdf",
    });
    expect(dup.status).toBe(409);
    expect(dup.json.error.details.existing.name).toBe("議事録 9/15");
    const same = await patch(USERS.yamada, id, { url: (await row(id)).url, changeNote: "同じ" });
    expect(same.status).toBe(200);
  });

  test("参考資料: 送った一式にする。新しく足したものだけを検証し、引き継いだ無効なものは残る", async () => {
    const id = await ctx.documentId("業界ニュースまとめ");
    const analysis = await ctx.documentId("現状分析");
    const survey = await ctx.documentId("調査レポート");
    const reply = await patch(USERS.yamada, id, { referenceIds: [analysis, survey] });
    expect(reply.status).toBe(200);
    expect(
      (
        await ctx.call("GET", `/api/series/${await ctx.seriesId("業界ニュースまとめ")}`, {
          cookie: await ctx.login(USERS.yamada),
        })
      ).json.references,
    ).toEqual([
      expect.objectContaining({ visibility: "visible", name: "調査レポート" }),
      { visibility: "deleted" },
    ]);
    const removed = await patch(USERS.yamada, id, { referenceIds: [survey] });
    expect(removed.status).toBe(200);
    const refs = await ctx.db
      .select()
      .from(schema.documentReferences)
      .where(eq(schema.documentReferences.documentId, id));
    expect(refs.map((r) => r.referencedDocumentId)).toEqual([survey]);

    const bad = await patch(USERS.yamada, id, {
      referenceIds: [survey, await ctx.documentId("研修カリキュラム")],
    });
    expect(bad.status).toBe(422);
    expect(bad.json.error.code).toBe("REFERENCE_UNAVAILABLE");
    const self = await patch(USERS.yamada, id, { referenceIds: [id] });
    expect(self.json.error.code).toBe("REFERENCE_UNAVAILABLE");
  });

  test("削除済みの版は 404 DOCUMENT_NOT_FOUND(系列が残っているので seriesExists: true)", async () => {
    const reply = await patch(USERS.yamada, await ctx.documentId("見積書 v2"), { changeNote: "x" });
    expect(reply.status).toBe(404);
    expect(reply.json.error).toMatchObject({
      code: "DOCUMENT_NOT_FOUND",
      details: { seriesExists: true },
    });
  });

  test("編集すると案件の最終更新が進む", async () => {
    const before = await lastActivity("A社 DX提案");
    await patch(USERS.sato, await ctx.documentId("提案書 v2"), { changeNote: "更新" });
    expect(await lastActivity("A社 DX提案")).toBeGreaterThan(before);
  });
});

describe("DELETE /api/documents/:documentId", () => {
  async function del(email: string, name: string) {
    return ctx.call("DELETE", `/api/documents/${await ctx.documentId(name)}`, {
      cookie: await ctx.login(email),
    });
  }

  test("旧版を消すと、系列が残り、旧版の件数が減る", async () => {
    const before = await lastActivity("A社 DX提案");
    const reply = await del(USERS.sato, "提案書 v2");
    expect(reply.status).toBe(200);
    expect(reply.json.seriesRemoved).toBe(false);
    expect(reply.json.series.olderCount).toBe(1);
    expect(reply.json.series.latest.name).toBe("提案書 v3");
    expect(await lastActivity("A社 DX提案")).toBeGreaterThan(before);
  });

  test("最新版を消すと、1つ前の版が最新版になる(消した版のタグは表から外れる)", async () => {
    const reply = await del(USERS.yamada, "提案書 v3");
    expect(reply.json.series.latest).toMatchObject({
      name: "提案書 v2",
      versionNo: 2,
      isLatest: true,
    });
    expect(reply.json.series.tags).toEqual([
      { label: "提出", versionNo: null },
      { label: "ドラフト", versionNo: 1 },
    ]);
  });

  test("系列の最後の1版を消すと系列が無くなり、案件の資料数と一覧から消える。リンクは登録し直せる", async () => {
    const reply = await del(USERS.sato, "調査レポート");
    expect(reply.json).toEqual({ seriesRemoved: true, series: null });
    const cookie = await ctx.login(USERS.sato);
    const project = await ctx.projectId("A社 DX提案");
    const list = await ctx.call("GET", `/api/projects/${project}/series`, { cookie });
    expect(list.json.series.map((r: Json) => r.latest.name)).not.toContain("調査レポート");
    expect(
      (await ctx.call("GET", `/api/projects/${project}`, { cookie })).json.project.documentCount,
    ).toBe(4);
    const again = await register(USERS.sato, "A社 DX提案", {
      url: "https://docs.google.com/document/d/seed-survey/edit",
      name: "調査レポート(再登録)",
      kind: "google_doc",
    });
    expect(again.status).toBe(201);
  });

  test("参考資料の行は残り、参考にした側には削除済みとして見える", async () => {
    await del(USERS.sato, "調査レポート");
    const detail = await ctx.call("GET", `/api/series/${await ctx.seriesId("提案書 v3")}`, {
      cookie: await ctx.login(USERS.yamada),
    });
    expect(detail.json.references).toContainEqual({ visibility: "deleted" });
  });

  test("削除済みの版をもう一度消すと 404 DOCUMENT_NOT_FOUND", async () => {
    const reply = await del(USERS.yamada, "見積書 v2");
    expect(reply.status).toBe(404);
    expect(reply.json.error.code).toBe("DOCUMENT_NOT_FOUND");
  });
});
