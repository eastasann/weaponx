/**
 * デモデータ(design-spec 8章)の投入。既存のデータは消してから入れる(03_dev-setup.md 4章)。
 * 結合テストと E2E もこのデータを土台にするので、`seedDemoData` を公開している。
 */
import { randomUUID } from "node:crypto";
import { labelKey, linkKey, nameKey, parseDriveLink } from "@weaponx/shared";
import { sql } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client";
import * as t from "../src/db/schema";

/** 日本時間の日時(省略した時刻は 10:00) */
const jst = (date: string, time = "10:00") => new Date(`2026-${date}T${time}:00+09:00`);

type UserKey = "yamada" | "sato" | "suzuki" | "tanaka" | "newcomer";
type Kind = (typeof t.documentKind.enumValues)[number];
type Role = (typeof t.projectRole.enumValues)[number];

const USERS: {
  key: UserKey;
  email: string;
  name: string | null;
  role: "member" | "admin";
  status: "active" | "suspended";
  lastLoginAt: Date | null;
  drive: "active" | "needs_reauth" | null;
}[] = [
  {
    key: "yamada",
    email: "yamada@example.com",
    name: "山田 太郎",
    role: "admin",
    status: "active",
    lastLoginAt: jst("09-30", "09:00"),
    drive: "active",
  },
  {
    key: "sato",
    email: "sato@example.com",
    name: "佐藤 花子",
    role: "member",
    status: "active",
    lastLoginAt: jst("09-29", "18:20"),
    drive: "active",
  },
  {
    key: "suzuki",
    email: "suzuki@example.com",
    name: "鈴木 一郎",
    role: "member",
    status: "suspended",
    lastLoginAt: jst("09-05", "16:45"),
    drive: "active",
  },
  {
    key: "tanaka",
    email: "tanaka@example.com",
    name: "田中 美咲",
    role: "member",
    status: "active",
    lastLoginAt: jst("09-27", "11:02"),
    drive: "needs_reauth",
  },
  {
    key: "newcomer",
    email: "new@example.com",
    name: null,
    role: "member",
    status: "active",
    lastLoginAt: null,
    drive: null,
  },
];

const DRIVE_SCOPES = ["openid", "email", "profile", "https://www.googleapis.com/auth/drive.file"];

type ProjectKey = "a" | "b" | "templates" | "c" | "d";

const PROJECTS: {
  key: ProjectKey;
  name: string;
  createdBy: UserKey;
  createdAt: Date;
  deleted?: { at: Date; by: UserKey };
  members: { user: UserKey; role: Role; at: Date }[];
}[] = [
  {
    key: "a",
    name: "A社 DX提案",
    createdBy: "yamada",
    createdAt: jst("09-01"),
    members: [
      { user: "yamada", role: "owner", at: jst("09-01") },
      { user: "sato", role: "editor", at: jst("09-03") },
      { user: "suzuki", role: "viewer", at: jst("09-05") },
    ],
  },
  {
    key: "b",
    name: "B社 市場調査",
    createdBy: "sato",
    createdAt: jst("09-02"),
    members: [
      { user: "sato", role: "owner", at: jst("09-02") },
      { user: "yamada", role: "editor", at: jst("09-04") },
      { user: "tanaka", role: "editor", at: jst("09-04") },
    ],
  },
  {
    key: "templates",
    name: "社内テンプレート集",
    createdBy: "tanaka",
    createdAt: jst("08-28"),
    members: [
      { user: "tanaka", role: "owner", at: jst("08-28") },
      { user: "yamada", role: "viewer", at: jst("08-29") },
      { user: "sato", role: "viewer", at: jst("08-29") },
    ],
  },
  {
    key: "c",
    name: "C社 業務改善",
    createdBy: "yamada",
    createdAt: jst("08-20"),
    deleted: { at: jst("09-10"), by: "yamada" },
    members: [{ user: "yamada", role: "owner", at: jst("08-20") }],
  },
  {
    key: "d",
    name: "D社 研修企画",
    createdBy: "suzuki",
    createdAt: jst("08-31"),
    members: [
      { user: "suzuki", role: "owner", at: jst("08-31") },
      { user: "tanaka", role: "editor", at: jst("09-01") },
    ],
  },
];

type VersionSeed = {
  id: string;
  name: string;
  url: string;
  kind: Kind;
  by: UserKey;
  via: "link" | "created" | "copied";
  /** 登録した日時。元の資料の更新日時を取り直して新しくなることがあるので、updated 以前になる */
  registeredAt: Date;
  /** 元の場所での更新日時(表の更新日時)。無いのは、登録日時を使う資料 */
  modifiedAt: Date | null;
  /** Google の資料だけ。ドライブの模擬が資料名と更新日時を返せるので、名前を取得済みにする */
  fetched: boolean;
  changeNote?: string;
  tags?: string[];
  deletedAt?: Date;
  deletedBy?: UserKey;
  references?: string[];
};

/** 参考資料が、後ろに書いた系列の版も指せるよう、キーから UUID を先に引けるようにしておく */
const ids = new Map<string, string>();
const id = (key: string) => {
  let v = ids.get(key);
  if (!v) {
    v = randomUUID();
    ids.set(key, v);
  }
  return v;
};

const gdoc = (path: "document" | "presentation" | "spreadsheets", file: string) =>
  `https://docs.google.com/${path}/d/${file}/edit`;

const SERIES: { key: string; project: ProjectKey; versions: VersionSeed[] }[] = [
  {
    key: "template",
    project: "templates",
    versions: [
      {
        id: id("template-v1"),
        name: "提案テンプレート",
        url: gdoc("presentation", "seed-template"),
        kind: "google_slides",
        by: "tanaka",
        via: "link",
        registeredAt: jst("08-28"),
        modifiedAt: jst("08-30"),
        fetched: true,
      },
    ],
  },
  {
    key: "survey",
    project: "a",
    versions: [
      {
        id: id("survey-v1"),
        name: "調査レポート",
        url: gdoc("document", "seed-survey"),
        kind: "google_doc",
        by: "sato",
        via: "created",
        registeredAt: jst("09-02"),
        modifiedAt: jst("09-20"),
        fetched: true,
      },
    ],
  },
  {
    key: "proposal",
    project: "a",
    versions: [
      {
        id: id("proposal-v1"),
        name: "提案書 初稿",
        url: gdoc("presentation", "seed-proposal-v1"),
        kind: "google_slides",
        by: "sato",
        via: "link",
        registeredAt: jst("09-03"),
        modifiedAt: jst("09-10"),
        fetched: true,
        tags: ["提出", "ドラフト"],
        references: [id("survey-v1"), id("template-v1")],
      },
      {
        id: id("proposal-v2"),
        name: "提案書 v2",
        url: gdoc("presentation", "seed-proposal-v2"),
        kind: "google_slides",
        by: "yamada",
        via: "link",
        registeredAt: jst("09-11"),
        modifiedAt: jst("09-21"),
        fetched: true,
        changeNote: "価格表を追加",
        tags: ["提出"],
        references: [id("survey-v1"), id("template-v1")],
      },
      {
        id: id("proposal-v3"),
        name: "提案書 v3",
        url: gdoc("presentation", "seed-proposal-v3"),
        kind: "google_slides",
        by: "yamada",
        via: "copied",
        registeredAt: jst("09-28", "10:10"),
        modifiedAt: jst("09-28", "10:12"),
        fetched: true,
        changeNote: "A社の指摘を反映",
        tags: ["確認済"],
        references: [id("survey-v1"), id("template-v1")],
      },
    ],
  },
  {
    key: "estimate",
    project: "a",
    versions: [
      {
        id: id("estimate-v1"),
        name: "見積書 v1",
        url: gdoc("spreadsheets", "seed-estimate-v1"),
        kind: "google_sheets",
        by: "yamada",
        via: "link",
        registeredAt: jst("09-12"),
        modifiedAt: jst("09-12"),
        fetched: true,
        references: [id("proposal-v1")],
      },
      {
        id: id("estimate-v2"),
        name: "見積書 v2",
        url: gdoc("spreadsheets", "seed-estimate-v2"),
        kind: "google_sheets",
        by: "yamada",
        via: "link",
        registeredAt: jst("09-13"),
        modifiedAt: jst("09-13"),
        fetched: true,
        tags: ["提出"],
        references: [id("proposal-v2")],
        deletedAt: jst("09-16"),
        deletedBy: "yamada",
      },
      {
        id: id("estimate-v3"),
        name: "見積書",
        url: gdoc("spreadsheets", "seed-estimate-v3"),
        kind: "google_sheets",
        by: "yamada",
        via: "link",
        registeredAt: jst("09-14"),
        modifiedAt: jst("09-18"),
        fetched: true,
        tags: ["確定"],
      },
    ],
  },
  {
    key: "minutes",
    project: "a",
    versions: [
      {
        id: id("minutes-v1"),
        name: "議事録 9/15",
        url: "https://example.com/files/minutes-0915.pdf",
        kind: "pdf",
        by: "sato",
        via: "link",
        registeredAt: jst("09-15"),
        modifiedAt: null,
        fetched: false,
      },
    ],
  },
  {
    key: "news",
    project: "a",
    versions: [
      {
        id: id("news-v1"),
        name: "業界ニュースまとめ",
        url: "https://example.com/news/digest",
        kind: "other",
        by: "yamada",
        via: "link",
        registeredAt: jst("09-04"),
        modifiedAt: jst("08-25"),
        fetched: false,
        references: [id("analysis-v1")],
      },
    ],
  },
  {
    key: "proposal-b",
    project: "b",
    versions: [
      {
        id: id("proposal-b-v1"),
        name: "提案書(B社向け)",
        url: gdoc("document", "seed-proposal-b"),
        kind: "google_doc",
        by: "yamada",
        via: "copied",
        registeredAt: jst("09-12"),
        modifiedAt: jst("09-12"),
        fetched: true,
        references: [id("proposal-v2")],
      },
    ],
  },
  {
    key: "competitors",
    project: "b",
    versions: [
      {
        id: id("competitors-v1"),
        name: "競合比較",
        url: gdoc("spreadsheets", "seed-competitors"),
        kind: "google_sheets",
        by: "tanaka",
        via: "link",
        registeredAt: jst("09-14"),
        modifiedAt: jst("09-14"),
        fetched: true,
        references: [id("training-v1")],
      },
    ],
  },
  {
    key: "analysis",
    project: "c",
    versions: [
      {
        id: id("analysis-v1"),
        name: "現状分析",
        url: gdoc("document", "seed-analysis"),
        kind: "google_doc",
        by: "yamada",
        via: "link",
        registeredAt: jst("08-20"),
        modifiedAt: jst("08-20"),
        fetched: true,
      },
    ],
  },
  {
    key: "training",
    project: "d",
    versions: [
      {
        id: id("training-v1"),
        name: "研修カリキュラム",
        url: gdoc("document", "seed-training"),
        kind: "google_doc",
        by: "suzuki",
        via: "link",
        registeredAt: jst("09-04"),
        modifiedAt: jst("09-06"),
        fetched: true,
      },
    ],
  },
];

/**
 * 全テーブルを空にしてデモデータを入れる。
 * 案件の `last_activity_at` は案件内の削除されていない版の更新日時(無ければ登録日時)の最大、
 * 系列の `next_version_no` は削除済みを含む最大の版番号 + 1 にそろえる(02-01 6章)。
 */
export async function seedDemoData(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      TRUNCATE TABLE document_tags, document_references, documents, document_series,
        project_members, projects, drive_connections, sessions, users CASCADE
    `);

    const userId = new Map<UserKey, string>(USERS.map((u) => [u.key, randomUUID()]));
    const uid = (k: UserKey) => userId.get(k) as string;

    await tx.insert(t.users).values(
      USERS.map((u) => ({
        id: uid(u.key),
        email: u.email,
        googleSubject: u.drive ? `demo-${u.key}` : null,
        displayName: u.name,
        globalRole: u.role,
        status: u.status,
        lastLoginAt: u.lastLoginAt,
        createdBy: u.key === "yamada" ? null : uid("yamada"),
        createdAt: jst("08-15"),
        updatedAt: jst("08-15"),
      })),
    );

    await tx.insert(t.driveConnections).values(
      USERS.flatMap((u) =>
        u.drive
          ? [
              {
                userId: uid(u.key),
                status: u.drive,
                credentials: "demo:dummy:dummy:dummy",
                grantedScopes: DRIVE_SCOPES,
                connectedAt: jst("09-01", "00:00"),
                createdAt: jst("09-01", "00:00"),
                updatedAt: jst("09-01", "00:00"),
              },
            ]
          : [],
      ),
    );

    const projectId = new Map<ProjectKey, string>(PROJECTS.map((p) => [p.key, randomUUID()]));
    const pid = (k: ProjectKey) => projectId.get(k) as string;

    const lastActivity = new Map<ProjectKey, Date>();
    for (const s of SERIES) {
      for (const v of s.versions) {
        if (v.deletedAt) continue;
        const at = v.modifiedAt ?? v.registeredAt;
        const prev = lastActivity.get(s.project);
        if (!prev || at > prev) lastActivity.set(s.project, at);
      }
    }

    await tx.insert(t.projects).values(
      PROJECTS.map((p) => ({
        id: pid(p.key),
        name: p.name,
        lastActivityAt: lastActivity.get(p.key) ?? p.createdAt,
        createdBy: uid(p.createdBy),
        deletedAt: p.deleted?.at ?? null,
        deletedBy: p.deleted ? uid(p.deleted.by) : null,
        createdAt: p.createdAt,
        updatedAt: p.createdAt,
      })),
    );

    await tx.insert(t.projectMembers).values(
      PROJECTS.flatMap((p) =>
        p.members.map((m) => ({
          projectId: pid(p.key),
          userId: uid(m.user),
          role: m.role,
          // 作成者自身の行は空(02-01 6章)
          addedBy: m.user === p.createdBy ? null : uid(p.createdBy),
          createdAt: m.at,
          updatedAt: m.at,
        })),
      ),
    );

    const seriesId = new Map<string, string>(SERIES.map((s) => [s.key, randomUUID()]));
    await tx.insert(t.documentSeries).values(
      SERIES.map((s) => ({
        id: seriesId.get(s.key) as string,
        projectId: pid(s.project),
        nextVersionNo: s.versions.length + 1,
        createdAt: s.versions[0]?.registeredAt,
        updatedAt: s.versions[0]?.registeredAt,
      })),
    );

    const documentRows: (typeof t.documents.$inferInsert)[] = [];
    const referenceRows: (typeof t.documentReferences.$inferInsert)[] = [];
    const tagRows: (typeof t.documentTags.$inferInsert)[] = [];

    for (const s of SERIES) {
      s.versions.forEach((v, i) => {
        const drive = parseDriveLink(v.url);
        documentRows.push({
          id: v.id,
          seriesId: seriesId.get(s.key) as string,
          projectId: pid(s.project),
          versionNo: i + 1,
          name: v.name,
          nameKey: nameKey(v.name),
          url: v.url,
          linkKey: linkKey(v.url),
          kind: v.kind,
          googleFileId: drive?.googleFileId ?? null,
          sourceModifiedAt: v.modifiedAt,
          metadataFetchedAt: v.fetched
            ? v.modifiedAt && v.modifiedAt > v.registeredAt
              ? v.modifiedAt
              : v.registeredAt
            : null,
          changeNote: v.changeNote ?? null,
          createdVia: v.via,
          registeredBy: uid(v.by),
          deletedAt: v.deletedAt ?? null,
          deletedBy: v.deletedBy ? uid(v.deletedBy) : null,
          createdAt: v.registeredAt,
          updatedAt: v.deletedAt ?? v.registeredAt,
        });
        for (const ref of v.references ?? []) {
          referenceRows.push({
            documentId: v.id,
            referencedDocumentId: ref,
            createdBy: uid(v.by),
            createdAt: v.registeredAt,
          });
        }
        (v.tags ?? []).forEach((label, position) => {
          tagRows.push({
            documentId: v.id,
            labelKey: labelKey(label),
            label,
            position: position + 1,
            createdBy: uid(v.by),
            createdAt: v.registeredAt,
          });
        });
      });
    }

    await tx.insert(t.documents).values(documentRows);
    await tx.insert(t.documentReferences).values(referenceRows);
    await tx.insert(t.documentTags).values(tagRows);
  });
}

const LOCAL_DB_HOSTS = ["db", "localhost", "127.0.0.1"];

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL が設定されていません");
    process.exit(1);
  }
  // 全テーブルを空にするので、NODE_ENV の設定漏れで本番の DB に向けても止まるよう接続先も見る
  const host = new URL(url).hostname;
  if (process.env.NODE_ENV === "production" || !LOCAL_DB_HOSTS.includes(host)) {
    console.error("デモデータは開発用・テスト用の DB(db・localhost)にだけ投入できます");
    process.exit(1);
  }
  const { db, sql: client } = createDb(url);
  try {
    await seedDemoData(db);
    console.log("デモデータを投入しました");
  } finally {
    await client.end();
  }
}
