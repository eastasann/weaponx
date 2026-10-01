import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, isNull, sql } from "drizzle-orm";
import { seedDemoData } from "../scripts/seed";
import { createDb } from "../src/db/client";
import * as t from "../src/db/schema";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL が設定されていません");
const { db, sql: client } = createDb(url);

/** Drizzle のクエリは Promise ではなく thenable なので、rejects に渡す前に包む */
const failing = (query: PromiseLike<unknown>) => expect(Promise.resolve(query)).rejects.toThrow();

beforeAll(() => seedDemoData(db));
afterAll(() => client.end());

describe("デモデータ(design-spec 8章)", () => {
  test("利用者5人と、ログイン済みの4人だけに連携の記録がある", async () => {
    const users = await db.select().from(t.users);
    expect(users).toHaveLength(5);
    const conns = await db
      .select({ email: t.users.email, status: t.driveConnections.status })
      .from(t.driveConnections)
      .innerJoin(t.users, eq(t.users.id, t.driveConnections.userId));
    expect(Object.fromEntries(conns.map((c) => [c.email, c.status]))).toEqual({
      "yamada@example.com": "active",
      "sato@example.com": "active",
      "suzuki@example.com": "active",
      "tanaka@example.com": "needs_reauth",
    });
  });

  test("有効な管理者が1人以上いる", async () => {
    const admins = await db
      .select()
      .from(t.users)
      .where(and(eq(t.users.globalRole, "admin"), eq(t.users.status, "active")));
    expect(admins.length).toBeGreaterThanOrEqual(1);
  });

  test("削除されていない案件にはオーナーが1人以上いる", async () => {
    const rows = await db.execute<{ name: string }>(sql`
      SELECT p.name FROM projects p
      WHERE p.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM project_members m WHERE m.project_id = p.id AND m.role = 'owner')
    `);
    expect(rows).toHaveLength(0);
  });

  test("案件の last_activity_at は、削除されていない版の更新日時(無ければ登録日時)の最大", async () => {
    const rows = await db.execute<{ name: string; ok: boolean }>(sql`
      SELECT p.name,
        p.last_activity_at = COALESCE(
          (SELECT max(COALESCE(d.source_modified_at, d.created_at))
             FROM documents d WHERE d.project_id = p.id AND d.deleted_at IS NULL),
          p.created_at) AS ok
      FROM projects p
    `);
    expect(rows.filter((r) => !r.ok)).toEqual([]);
  });

  test("系列の next_version_no は削除済みを含む最大の版番号 + 1", async () => {
    const rows = await db.execute<{ id: string }>(sql`
      SELECT s.id FROM document_series s
      WHERE s.next_version_no <> (SELECT max(d.version_no) + 1 FROM documents d WHERE d.series_id = s.id)
    `);
    expect(rows).toHaveLength(0);
  });

  test("版の project_id は系列の案件と同じ", async () => {
    const rows = await db.execute<{ id: string }>(sql`
      SELECT d.id FROM documents d JOIN document_series s ON s.id = d.series_id
      WHERE d.project_id <> s.project_id
    `);
    expect(rows).toHaveLength(0);
  });

  test("表の例: 提案書は3版、見積書は削除済みの v2 を含む", async () => {
    const versions = await db
      .select({
        name: t.documents.name,
        no: t.documents.versionNo,
        deletedAt: t.documents.deletedAt,
      })
      .from(t.documents)
      .where(sql`${t.documents.name} like '見積書%'`)
      .orderBy(t.documents.versionNo);
    expect(versions.map((v) => [v.no, v.name, v.deletedAt !== null])).toEqual([
      [1, "見積書 v1", false],
      [2, "見積書 v2", true],
      [3, "見積書", false],
    ]);
  });

  test("提案書 v3 のタグは「確認済」で、v1 には「提出」「ドラフト」が付けた順に付く", async () => {
    const tags = await db
      .select({ name: t.documents.name, label: t.documentTags.label, pos: t.documentTags.position })
      .from(t.documentTags)
      .innerJoin(t.documents, eq(t.documents.id, t.documentTags.documentId))
      .where(sql`${t.documents.name} in ('提案書 初稿', '提案書 v3')`)
      .orderBy(t.documents.name, t.documentTags.position);
    expect(tags.map((x) => [x.name, x.label, x.pos])).toEqual([
      ["提案書 v3", "確認済", 1],
      ["提案書 初稿", "提出", 1],
      ["提案書 初稿", "ドラフト", 2],
    ]);
  });

  test("C社は削除済み、その資料は残っている", async () => {
    const [c] = await db.select().from(t.projects).where(eq(t.projects.name, "C社 業務改善"));
    expect(c?.deletedAt).not.toBeNull();
    const docs = await db
      .select()
      .from(t.documents)
      .where(eq(t.documents.projectId, c?.id ?? ""));
    expect(docs).toHaveLength(1);
  });

  test("参考資料は11本で、自己参照を含まない", async () => {
    const refs = await db.select().from(t.documentReferences);
    expect(refs).toHaveLength(11);
    expect(refs.some((r) => r.documentId === r.referencedDocumentId)).toBe(false);
  });

  test("議事録は更新日時を持たず、Google の資料だけがファイル ID を持つ", async () => {
    const [minutes] = await db
      .select()
      .from(t.documents)
      .where(eq(t.documents.name, "議事録 9/15"));
    expect(minutes?.sourceModifiedAt).toBeNull();
    const withFileId = await db
      .select({ name: t.documents.name })
      .from(t.documents)
      .where(and(sql`${t.documents.googleFileId} is not null`, isNull(t.documents.deletedAt)));
    expect(withFileId.some((d) => d.name === "議事録 9/15")).toBe(false);
  });
});

describe("スキーマが守る規則", () => {
  test("同じ案件で削除されていない版は同じリンクを持てない。削除済みなら持てる", async () => {
    const [v] = await db.select().from(t.documents).where(eq(t.documents.name, "提案書 v3"));
    if (!v) throw new Error("seed");
    const dup = {
      seriesId: v.seriesId,
      projectId: v.projectId,
      versionNo: 99,
      name: "重複",
      nameKey: "重複",
      url: v.url,
      linkKey: v.linkKey,
      kind: v.kind,
      createdVia: "link" as const,
      registeredBy: v.registeredBy,
    };
    await failing(db.insert(t.documents).values(dup));
    const [e2] = await db.select().from(t.documents).where(eq(t.documents.name, "見積書 v2"));
    if (!e2) throw new Error("seed");
    await db.insert(t.documents).values({
      ...dup,
      seriesId: e2.seriesId,
      projectId: e2.projectId,
      linkKey: e2.linkKey,
      deletedAt: new Date(),
    });
    await db.delete(t.documents).where(eq(t.documents.versionNo, 99));
  });

  test("同じ系列で版番号は重ならない", async () => {
    const [v] = await db.select().from(t.documents).where(eq(t.documents.name, "提案書 v3"));
    if (!v) throw new Error("seed");
    await failing(
      db.insert(t.documents).values({
        seriesId: v.seriesId,
        projectId: v.projectId,
        versionNo: v.versionNo,
        name: "x",
        nameKey: "x",
        url: "https://example.com/unique",
        linkKey: "u:https://example.com/unique",
        kind: "other",
        createdVia: "link",
        registeredBy: v.registeredBy,
      }),
    );
  });

  test("メールは小文字だけ", async () => {
    await failing(db.insert(t.users).values({ email: "Upper@example.com" }));
  });

  test("参考資料の自己参照は入らない", async () => {
    const [v] = await db.select().from(t.documents).limit(1);
    if (!v) throw new Error("seed");
    await failing(
      db
        .insert(t.documentReferences)
        .values({ documentId: v.id, referencedDocumentId: v.id, createdBy: v.registeredBy }),
    );
  });
});
