/**
 * 02-01 7章の権限マトリクスのうち、資料・検索・ドライブのエンドポイントの行を、役割ごとに叩いて確かめる。
 * 状態を変える操作は、成功したときに次の行へ影響しないよう毎回シードし直す。
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { createTestContext, USERS } from "./helpers";

const ctx = createTestContext();
beforeEach(() => ctx.seed());
afterAll(() => ctx.close());

type Who = "anon" | "outsider" | "viewer" | "editor" | "owner";

/** 「A社 DX提案」での役割: 山田がオーナー、佐藤が編集者、田中を閲覧者に入れる。不参加はどの案件にも入っていない人 */
async function cookieFor(who: Who): Promise<string | undefined> {
  switch (who) {
    case "anon":
      return undefined;
    case "owner":
      return ctx.login(USERS.yamada);
    case "editor":
      return ctx.login(USERS.sato);
    case "viewer":
      await ctx.db.insert(schema.projectMembers).values({
        projectId: await ctx.projectId("A社 DX提案"),
        userId: await ctx.userId(USERS.tanaka),
        role: "viewer",
      });
      return ctx.login(USERS.tanaka);
    case "outsider":
      await ctx.db
        .update(schema.users)
        .set({ googleSubject: "demo-newcomer" })
        .where(eq(schema.users.email, USERS.newcomer));
      return ctx.login(USERS.newcomer);
  }
}

type Ids = { project: string; series: string; document: string; reference: string };

type Row = {
  label: string;
  method: string;
  path: (ids: Ids) => string;
  body?: (ids: Ids) => unknown;
  expect: Record<Who, number>;
  /** 案件・系列・版が見つからない・参加していないときのコード */
  notFound?: "PROJECT_NOT_FOUND";
};

const read = { anon: 401, outsider: 404, viewer: 200, editor: 200, owner: 200 } as const;
const write = (ok: number) => ({ anon: 401, outsider: 404, viewer: 403, editor: ok, owner: ok });

const rows: Row[] = [
  {
    label: "資料の一覧",
    method: "GET",
    path: (i) => `/api/projects/${i.project}/series`,
    expect: read,
  },
  {
    label: "タグの候補",
    method: "GET",
    path: (i) => `/api/projects/${i.project}/tags`,
    expect: read,
  },
  { label: "横パネル", method: "GET", path: (i) => `/api/series/${i.series}`, expect: read },
  {
    label: "資料の追加(リンクで登録)",
    method: "POST",
    path: (i) => `/api/projects/${i.project}/documents`,
    body: () => ({ url: "https://example.com/new", name: "新規", kind: "other" }),
    expect: write(201),
  },
  {
    label: "新しい版の登録",
    method: "POST",
    path: (i) => `/api/series/${i.series}/versions`,
    body: () => ({ url: "https://example.com/new", name: "新規", kind: "other" }),
    expect: write(201),
  },
  {
    label: "登録内容の編集",
    method: "PATCH",
    path: (i) => `/api/documents/${i.document}`,
    body: () => ({ changeNote: "編集" }),
    expect: write(200),
  },
  {
    label: "版の削除",
    method: "DELETE",
    path: (i) => `/api/documents/${i.document}`,
    expect: write(200),
  },
  {
    // 参加している案件の分だけ返す。不参加の人にも 200(空の結果)
    label: "横断検索",
    method: "GET",
    path: () => "/api/search?q=%E6%8F%90%E6%A1%88",
    expect: { anon: 401, outsider: 200, viewer: 200, editor: 200, owner: 200 },
  },
  {
    label: "参考資料の候補",
    method: "GET",
    path: () => "/api/reference-candidates",
    expect: { anon: 401, outsider: 200, viewer: 200, editor: 200, owner: 200 },
  },
  {
    // 案件の役割は関係なく、呼んだ人自身のドライブ連携で決まる: 佐藤は登録した人なので 200、
    // 山田はまだ使えないので 422、連携が要再連携(田中)・連携の記録が無い人(新規)は 409
    label: "ドライブの情報取得",
    method: "POST",
    path: () => "/api/drive/file-info",
    body: () => ({ fileId: "seed-survey" }),
    expect: { anon: 401, outsider: 409, viewer: 409, editor: 200, owner: 422 },
  },
];

describe("資料のエンドポイントの権限マトリクス", () => {
  for (const row of rows) {
    for (const [who, status] of Object.entries(row.expect) as [Who, number][]) {
      test(`${row.label}: ${who} は ${status}`, async () => {
        const cookie = await cookieFor(who);
        const ids: Ids = {
          project: await ctx.projectId("A社 DX提案"),
          series: await ctx.seriesId("提案書 v3"),
          document: await ctx.documentId("提案書 v2"),
          reference: await ctx.documentId("調査レポート"),
        };
        const reply = await ctx.call(row.method, row.path(ids), { cookie, body: row.body?.(ids) });
        expect(reply.status).toBe(status);
        if (status === 404) expect(reply.json.error.code).toBe("PROJECT_NOT_FOUND");
        if (status === 409) expect(reply.json.error.code).toBe("DRIVE_REAUTH_REQUIRED");
        if (status === 403) expect(reply.json.error.code).toBe("ROLE_INSUFFICIENT");
        if (status === 401) expect(reply.json.error.code).toBe("UNAUTHENTICATED");
      });
    }
  }

  test("入力の検証より先に認可を確かめる(不正な入力でも 404 / 403)", async () => {
    const project = await ctx.projectId("A社 DX提案");
    const series = await ctx.seriesId("提案書 v3");
    const document = await ctx.documentId("提案書 v2");
    const outsider = (await cookieFor("outsider")) as string;
    const viewer = (await cookieFor("viewer")) as string;
    const bad = { url: "javascript:x", name: "", kind: "pdf" };
    const cases: [string, string, string, number, unknown?][] = [
      ["POST", `/api/projects/${project}/documents`, outsider, 404, bad],
      ["POST", `/api/projects/${project}/documents`, viewer, 403, bad],
      ["POST", `/api/series/${series}/versions`, outsider, 404, bad],
      ["POST", `/api/series/${series}/versions`, viewer, 403, bad],
      [
        "PATCH",
        `/api/documents/${document}`,
        outsider,
        404,
        { tags: ["a", "b", "c", "d", "e", "f"] },
      ],
      [
        "PATCH",
        `/api/documents/${document}`,
        viewer,
        403,
        { tags: ["a", "b", "c", "d", "e", "f"] },
      ],
      ["GET", `/api/projects/${project}/tags?q=${"あ".repeat(101)}`, outsider, 404],
    ];
    for (const [method, path, cookie, status, body] of cases) {
      const reply = await ctx.call(method, path, { cookie, body });
      expect([method, path, reply.status]).toEqual([method, path, status]);
      expect(reply.json.error.code).toBe(
        status === 404 ? "PROJECT_NOT_FOUND" : "ROLE_INSUFFICIENT",
      );
    }
  });

  test("系列・版の ID は、存在しない → DOCUMENT_NOT_FOUND、不参加 → PROJECT_NOT_FOUND、削除済み → DOCUMENT_NOT_FOUND、役割不足 → 403 の順に判定する", async () => {
    const viewer = (await cookieFor("viewer")) as string;
    const editor = (await cookieFor("editor")) as string;
    const missing = crypto.randomUUID();
    const deleted = await ctx.documentId("見積書 v2");
    // 閲覧者は、削除済みの版に対して役割不足(403)より先に 404 を受ける
    const cases: [string, string, string, number, string][] = [
      ["PATCH", `/api/documents/${missing}`, editor, 404, "DOCUMENT_NOT_FOUND"],
      ["PATCH", `/api/documents/${deleted}`, viewer, 404, "DOCUMENT_NOT_FOUND"],
      ["DELETE", `/api/documents/${deleted}`, viewer, 404, "DOCUMENT_NOT_FOUND"],
      ["POST", `/api/series/${missing}/versions`, editor, 404, "DOCUMENT_NOT_FOUND"],
      ["GET", `/api/series/${missing}`, viewer, 404, "DOCUMENT_NOT_FOUND"],
    ];
    for (const [method, path, cookie, status, code] of cases) {
      const body = { url: "https://example.com/x", name: "x", kind: "other", changeNote: "x" };
      const reply = await ctx.call(method, path, {
        cookie,
        body: method === "GET" ? undefined : body,
      });
      expect([method, path, reply.status, reply.json.error.code]).toEqual([
        method,
        path,
        status,
        code,
      ]);
    }
  });

  test("管理者(山田)は参加していない案件(D社)の資料のどの操作も 404 PROJECT_NOT_FOUND", async () => {
    const cookie = await ctx.login(USERS.yamada);
    const project = await ctx.projectId("D社 研修企画");
    const series = await ctx.seriesId("研修カリキュラム");
    const document = await ctx.documentId("研修カリキュラム");
    const body = { url: "https://example.com/x", name: "x", kind: "other" };
    const calls: [string, string, unknown?][] = [
      ["GET", `/api/projects/${project}/series`],
      ["GET", `/api/projects/${project}/tags`],
      ["GET", `/api/series/${series}`],
      ["POST", `/api/projects/${project}/documents`, body],
      ["POST", `/api/series/${series}/versions`, body],
      ["PATCH", `/api/documents/${document}`, { changeNote: "x" }],
      ["DELETE", `/api/documents/${document}`],
    ];
    for (const [method, path, payload] of calls) {
      const reply = await ctx.call(method, path, { cookie, body: payload });
      expect([method, path, reply.status]).toEqual([method, path, 404]);
      expect(reply.json.error.code).toBe("PROJECT_NOT_FOUND");
    }
  });

  test("削除済みの案件(C社)の資料は、元メンバーでも 404 PROJECT_NOT_FOUND", async () => {
    const cookie = await ctx.login(USERS.yamada);
    const project = await ctx.projectId("C社 業務改善");
    const reply = await ctx.call("GET", `/api/projects/${project}/series`, { cookie });
    expect(reply.status).toBe(404);
    expect(reply.json.error.code).toBe("PROJECT_NOT_FOUND");
  });

  test("案件の削除と版の登録が同時に走っても、削除された案件に版は増えない", async () => {
    const project = await ctx.projectId("A社 DX提案");
    const cookie = await ctx.login(USERS.yamada);
    const [removed, ...registered] = await Promise.all([
      ctx.call("DELETE", `/api/projects/${project}`, { cookie }),
      ...[1, 2, 3].map((n) =>
        ctx.call("POST", `/api/projects/${project}/documents`, {
          cookie,
          body: {
            url: `https://example.com/during-delete-${n}`,
            name: `削除中 ${n}`,
            kind: "other",
          },
        }),
      ),
    ]);
    expect(removed.status).toBe(204);
    const created = registered.filter((r) => r.status === 201).length;
    const docs = await ctx.db
      .select()
      .from(schema.documents)
      .where(eq(schema.documents.projectId, project));
    // 削除の前に通った登録だけが残り、後の登録は 404 になる
    expect(docs.filter((d) => d.name.startsWith("削除中"))).toHaveLength(created);
    for (const reply of registered.filter((r) => r.status !== 201)) {
      expect(reply.json.error.code).toBe("PROJECT_NOT_FOUND");
    }
  });
});
