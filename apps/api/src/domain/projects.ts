import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import * as t from "../db/schema";
import { AppError, parseUuid } from "../lib/errors";

export type ProjectRole = "owner" | "editor" | "viewer";

const ROLE_RANK: Record<ProjectRole, number> = { viewer: 1, editor: 2, owner: 3 };

export const roleAtLeast = (role: ProjectRole, min: ProjectRole) =>
  ROLE_RANK[role] >= ROLE_RANK[min];

/** `Db` かトランザクション(`db.transaction` の引数) */
export type DbOrTx = Pick<Db, "select" | "insert" | "update" | "delete" | "execute">;

export type ProjectRow = {
  id: string;
  name: string;
  myRole: ProjectRole;
  documentCount: number;
  lastActivityAt: string;
};

export type ProjectDetail = {
  id: string;
  name: string;
  myRole: ProjectRole;
  memberCount: number;
  documentCount: number;
  lastActivityAt: string;
};

/** 案件の資料数: 削除されていない版を1件以上持つ系列の数(02-01 6章「導出する値」) */
const documentCountSql = sql<number>`(
  select count(*)::int from ${t.documentSeries}
  where ${t.documentSeries.projectId} = ${t.projects.id}
    and exists (
      select 1 from ${t.documents}
      where ${t.documents.seriesId} = ${t.documentSeries.id} and ${t.documents.deletedAt} is null
    )
)`;

const memberCountSql = sql<number>`(
  select count(*)::int from ${t.projectMembers} pm where pm.project_id = ${t.projects.id}
)`;

/**
 * 案件を見られる利用者の役割を返す。案件が無い・削除済み・不参加はどれも `PROJECT_NOT_FOUND`
 * (存在を漏らさない。02-01 7章)、役割が足りなければ `ROLE_INSUFFICIENT`。
 * 管理者であることは案件の権限を足さない(design-spec 2.1)。
 */
export async function requireProjectRole(
  db: DbOrTx,
  userId: string,
  projectId: string,
  min: ProjectRole,
): Promise<ProjectRole> {
  const id = parseUuid(projectId, "PROJECT_NOT_FOUND");
  const [row] = await db
    .select({ role: t.projectMembers.role })
    .from(t.projectMembers)
    .innerJoin(t.projects, eq(t.projects.id, t.projectMembers.projectId))
    .where(
      and(
        eq(t.projectMembers.projectId, id),
        eq(t.projectMembers.userId, userId),
        isNull(t.projects.deletedAt),
      ),
    );
  if (!row) throw new AppError("PROJECT_NOT_FOUND");
  if (!roleAtLeast(row.role, min)) throw new AppError("ROLE_INSUFFICIENT");
  return row.role;
}

/**
 * 案件の行をロックしてから役割を確かめる(ADR-013)。メンバーの変更や案件の更新は、
 * オーナーが同時に変わっても規則が破れないよう、この中で行う。
 */
export async function lockProjectAndRequireRole(
  tx: DbOrTx,
  userId: string,
  projectId: string,
  min: ProjectRole,
): Promise<ProjectRole> {
  const id = parseUuid(projectId, "PROJECT_NOT_FOUND");
  await tx.execute(sql`select 1 from ${t.projects} where ${t.projects.id} = ${id} for update`);
  return requireProjectRole(tx, userId, id, min);
}

/**
 * 案件の行を共有ロック(`FOR KEY SHARE`)してから役割を確かめる。資料の登録・編集は同じ案件で
 * 同時に走れるが、案件の削除やメンバーの変更(`FOR UPDATE`)とは直列になるので、
 * 役割と案件の状態は、この中の書き込みが終わるまで変わらない。
 */
export async function shareLockProjectAndRequireRole(
  tx: DbOrTx,
  userId: string,
  projectId: string,
  min: ProjectRole,
): Promise<ProjectRole> {
  const id = parseUuid(projectId, "PROJECT_NOT_FOUND");
  await tx.execute(sql`select 1 from ${t.projects} where ${t.projects.id} = ${id} for key share`);
  return requireProjectRole(tx, userId, id, min);
}

export async function listProjects(
  db: Db,
  userId: string,
  minRole: ProjectRole = "viewer",
): Promise<ProjectRow[]> {
  const rows = await db
    .select({
      id: t.projects.id,
      name: t.projects.name,
      myRole: t.projectMembers.role,
      documentCount: documentCountSql,
      lastActivityAt: t.projects.lastActivityAt,
    })
    .from(t.projectMembers)
    .innerJoin(t.projects, eq(t.projects.id, t.projectMembers.projectId))
    .where(and(eq(t.projectMembers.userId, userId), isNull(t.projects.deletedAt)))
    .orderBy(desc(t.projects.lastActivityAt), t.projects.id);
  return rows
    .filter((row) => roleAtLeast(row.myRole, minRole))
    .map((row) => ({ ...row, lastActivityAt: row.lastActivityAt.toISOString() }));
}

/** 案件を作り、作成者を最初のオーナーにする(design-spec 2.1) */
export async function createProject(db: Db, userId: string, name: string): Promise<ProjectRow> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const [project] = await tx
      .insert(t.projects)
      .values({ name, createdBy: userId, lastActivityAt: now })
      .returning();
    if (!project) throw new Error("案件の作成に失敗しました");
    await tx.insert(t.projectMembers).values({ projectId: project.id, userId, role: "owner" });
    return {
      id: project.id,
      name: project.name,
      myRole: "owner",
      documentCount: 0,
      lastActivityAt: project.lastActivityAt.toISOString(),
    };
  });
}

export async function getProject(
  db: DbOrTx,
  userId: string,
  projectId: string,
): Promise<ProjectDetail> {
  const id = parseUuid(projectId, "PROJECT_NOT_FOUND");
  const [row] = await db
    .select({
      id: t.projects.id,
      name: t.projects.name,
      myRole: t.projectMembers.role,
      memberCount: memberCountSql,
      documentCount: documentCountSql,
      lastActivityAt: t.projects.lastActivityAt,
    })
    .from(t.projectMembers)
    .innerJoin(t.projects, eq(t.projects.id, t.projectMembers.projectId))
    .where(
      and(
        eq(t.projectMembers.projectId, id),
        eq(t.projectMembers.userId, userId),
        isNull(t.projects.deletedAt),
      ),
    );
  if (!row) throw new AppError("PROJECT_NOT_FOUND");
  return { ...row, lastActivityAt: row.lastActivityAt.toISOString() };
}

export async function renameProject(
  db: Db,
  userId: string,
  projectId: string,
  name: string,
): Promise<ProjectDetail> {
  await db.transaction(async (tx) => {
    await lockProjectAndRequireRole(tx, userId, projectId, "owner");
    const now = new Date();
    await tx
      .update(t.projects)
      .set({ name, lastActivityAt: now })
      .where(eq(t.projects.id, projectId));
  });
  return getProject(db, userId, projectId);
}

export async function deleteProject(db: Db, userId: string, projectId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await lockProjectAndRequireRole(tx, userId, projectId, "owner");
    await tx
      .update(t.projects)
      .set({ deletedAt: new Date(), deletedBy: userId })
      .where(eq(t.projects.id, projectId));
  });
}
