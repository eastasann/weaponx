import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const globalRole = pgEnum("global_role", ["member", "admin"]);
export const userStatus = pgEnum("user_status", ["active", "suspended"]);
export const localeEnum = pgEnum("locale", ["ja", "en"]);
export const driveStatus = pgEnum("drive_status", ["active", "needs_reauth"]);
export const projectRole = pgEnum("project_role", ["owner", "editor", "viewer"]);
export const documentKind = pgEnum("document_kind", [
  "google_doc",
  "google_slides",
  "google_sheets",
  "pdf",
  "other",
]);
export const createdVia = pgEnum("created_via", ["link", "created", "copied"]);

const tz = (name: string) => timestamp(name, { withTimezone: true });

const timestamps = {
  createdAt: tz("created_at").notNull().defaultNow(),
  updatedAt: tz("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(), // 小文字にそろえて保存
    googleSubject: text("google_subject"),
    displayName: text("display_name"),
    avatarUrl: text("avatar_url"),
    globalRole: globalRole("global_role").notNull().default("member"),
    status: userStatus("status").notNull().default("active"),
    locale: localeEnum("locale"),
    lastLoginAt: tz("last_login_at"),
    createdBy: uuid("created_by").references((): AnyPgColumn => users.id), // 監査用
    ...timestamps,
  },
  (t) => [
    uniqueIndex("users_email_key").on(t.email),
    uniqueIndex("users_google_subject_key").on(t.googleSubject),
    check("users_email_lowercase", sql`${t.email} = lower(${t.email})`),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(), // SHA-256(Cookie のトークン) の16進
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: tz("expires_at").notNull(),
    createdAt: tz("created_at").notNull().defaultNow(),
    lastUsedAt: tz("last_used_at").notNull().defaultNow(),
  },
  (t) => [
    index("sessions_user_id_idx").on(t.userId),
    index("sessions_expires_at_idx").on(t.expiresAt),
  ],
);

export const driveConnections = pgTable("drive_connections", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id),
  status: driveStatus("status").notNull(),
  credentials: text("credentials").notNull(), // "{鍵ID}:{IV}:{暗号文}:{タグ}"(ADR-012)
  grantedScopes: text("granted_scopes").array().notNull(),
  connectedAt: tz("connected_at").notNull(), // 最後に許可を得た日時。監査用
  ...timestamps,
});

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  lastActivityAt: tz("last_activity_at").notNull().defaultNow(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id), // 監査用
  deletedAt: tz("deleted_at"),
  deletedBy: uuid("deleted_by").references(() => users.id), // 監査用
  ...timestamps,
});

export const projectMembers = pgTable(
  "project_members",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: projectRole("role").notNull(),
    addedBy: uuid("added_by").references(() => users.id), // 監査用。作成者自身の行は空
    ...timestamps, // created_at をメンバー管理の「追加日」に使う
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.userId] }),
    index("project_members_user_id_idx").on(t.userId),
  ],
);

export const documentSeries = pgTable(
  "document_series",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    nextVersionNo: integer("next_version_no").notNull().default(1),
    ...timestamps,
  },
  (t) => [index("document_series_project_id_idx").on(t.projectId)],
);

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seriesId: uuid("series_id")
      .notNull()
      .references(() => documentSeries.id),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id), // 系列の案件の写し(変わらない)
    versionNo: integer("version_no").notNull(),
    name: text("name").notNull(),
    nameKey: text("name_key").notNull(), // NFKC + 小文字
    url: text("url").notNull(),
    linkKey: text("link_key").notNull(), // "g:{google_file_id}"(ドライブの資料)| "u:{url}"
    kind: documentKind("kind").notNull(),
    googleFileId: text("google_file_id"), // ドライブの資料(5.1)のファイル ID
    sourceModifiedAt: tz("source_modified_at"),
    metadataFetchedAt: tz("metadata_fetched_at"),
    changeNote: text("change_note"),
    createdVia: createdVia("created_via").notNull(), // 監査用
    registeredBy: uuid("registered_by")
      .notNull()
      .references(() => users.id),
    deletedAt: tz("deleted_at"),
    deletedBy: uuid("deleted_by").references(() => users.id), // 監査用
    ...timestamps, // created_at を登録日時として使う
  },
  (t) => [
    uniqueIndex("documents_series_version_key").on(t.seriesId, t.versionNo),
    uniqueIndex("documents_project_link_key")
      .on(t.projectId, t.linkKey)
      .where(sql`${t.deletedAt} is null`),
    index("documents_series_id_idx").on(t.seriesId),
    index("documents_project_id_idx").on(t.projectId),
    index("documents_name_key_trgm_idx").using("gin", t.nameKey.op("gin_trgm_ops")),
    check("documents_version_no_positive", sql`${t.versionNo} >= 1`),
  ],
);

export const documentReferences = pgTable(
  "document_references",
  {
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id),
    referencedDocumentId: uuid("referenced_document_id")
      .notNull()
      .references(() => documents.id),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id), // 監査用
    createdAt: tz("created_at").notNull().defaultNow(), // 追加と削除だけ。updated_at は持たない
  },
  (t) => [
    primaryKey({ columns: [t.documentId, t.referencedDocumentId] }),
    index("document_references_referenced_idx").on(t.referencedDocumentId),
    check("document_references_not_self", sql`${t.documentId} <> ${t.referencedDocumentId}`),
  ],
);

export const documentTags = pgTable(
  "document_tags",
  {
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id),
    labelKey: text("label_key").notNull(), // NFKC + 小文字
    label: text("label").notNull(), // 入力されたとおり
    position: integer("position").notNull(), // 付けた順。版の中で増えていく(消しても詰めない)
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id), // 監査用
    createdAt: tz("created_at").notNull().defaultNow(), // 追加と削除だけ。updated_at は持たない
  },
  (t) => [primaryKey({ columns: [t.documentId, t.labelKey] })],
);
