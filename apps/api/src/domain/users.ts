import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { AuthUser } from "../auth/session";
import type { Db } from "../db/client";
import * as t from "../db/schema";
import { AppError, isUniqueViolation, parseUuid } from "../lib/errors";

export type AdminUser = {
  id: string;
  email: string;
  displayName: string | null;
  globalRole: "member" | "admin";
  status: "active" | "suspended";
  hasLoggedIn: boolean;
  lastLoginAt: string | null;
};

/** 管理者の変更を直列にする advisory lock のキー。「管理者全体」を表す行が無いので行ロックの代わりに使う(ADR-013) */
const ADMIN_LOCK_KEY = 7_301_001;

const adminColumns = {
  id: t.users.id,
  email: t.users.email,
  displayName: t.users.displayName,
  globalRole: t.users.globalRole,
  status: t.users.status,
  googleSubject: t.users.googleSubject,
  lastLoginAt: t.users.lastLoginAt,
};

function toAdminUser(row: {
  id: string;
  email: string;
  displayName: string | null;
  globalRole: "member" | "admin";
  status: "active" | "suspended";
  googleSubject: string | null;
  lastLoginAt: Date | null;
}): AdminUser {
  const { googleSubject, lastLoginAt, ...rest } = row;
  return {
    ...rest,
    hasLoggedIn: googleSubject !== null,
    lastLoginAt: lastLoginAt ? lastLoginAt.toISOString() : null,
  };
}

export async function listUsers(db: Db): Promise<AdminUser[]> {
  const rows = await db.select(adminColumns).from(t.users).orderBy(asc(t.users.email));
  return rows.map(toAdminUser);
}

export async function createUser(
  db: Db,
  actorId: string,
  email: string,
  admin: boolean,
): Promise<AdminUser> {
  try {
    const [row] = await db
      .insert(t.users)
      .values({ email, globalRole: admin ? "admin" : "member", createdBy: actorId })
      .returning(adminColumns);
    if (!row) throw new Error("利用者の作成に失敗しました");
    return toAdminUser(row);
  } catch (error) {
    if (isUniqueViolation(error, "users_email_key")) throw new AppError("EMAIL_TAKEN");
    throw error;
  }
}

async function countActiveAdmins(tx: Pick<Db, "select">): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(t.users)
    .where(and(eq(t.users.globalRole, "admin"), eq(t.users.status, "active")));
  return row?.count ?? 0;
}

/**
 * 停止・再開と管理者の付与・解除。自分自身は変更できず(`SELF_CHANGE_FORBIDDEN`)、
 * 最後の有効な管理者は外せない・停止できない(`LAST_ADMIN`)。同じ結果になる操作は成功として扱う。
 * 停止してもセッションは消さない(次のリクエストで消す。02-01 5.9)。
 */
export async function updateUser(
  db: Db,
  actorId: string,
  targetUserId: string,
  change: { status?: "active" | "suspended"; globalRole?: "member" | "admin" },
): Promise<AdminUser> {
  const targetId = parseUuid(targetUserId, "NOT_FOUND");
  if (targetId === actorId) throw new AppError("SELF_CHANGE_FORBIDDEN");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ADMIN_LOCK_KEY})`);
    const [current] = await tx.select(adminColumns).from(t.users).where(eq(t.users.id, targetId));
    if (!current) throw new AppError("NOT_FOUND");

    const next = {
      status: change.status ?? current.status,
      globalRole: change.globalRole ?? current.globalRole,
    };
    if (next.status === current.status && next.globalRole === current.globalRole) {
      return toAdminUser(current);
    }
    const wasActiveAdmin = current.globalRole === "admin" && current.status === "active";
    const staysActiveAdmin = next.globalRole === "admin" && next.status === "active";
    if (wasActiveAdmin && !staysActiveAdmin && (await countActiveAdmins(tx)) <= 1) {
      throw new AppError("LAST_ADMIN");
    }
    const [updated] = await tx
      .update(t.users)
      .set(next)
      .where(eq(t.users.id, targetId))
      .returning(adminColumns);
    if (!updated) throw new AppError("NOT_FOUND");
    return toAdminUser(updated);
  });
}

/** 停止の確認ダイアログ用。その人が唯一のオーナーになっている、削除されていない案件の数(02-01 6章) */
export async function soleOwnerCount(db: Db, targetUserId: string): Promise<number> {
  const targetId = parseUuid(targetUserId, "NOT_FOUND");
  const [user] = await db.select({ id: t.users.id }).from(t.users).where(eq(t.users.id, targetId));
  if (!user) throw new AppError("NOT_FOUND");
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(t.projectMembers)
    .innerJoin(t.projects, eq(t.projects.id, t.projectMembers.projectId))
    .where(
      and(
        eq(t.projectMembers.userId, targetId),
        eq(t.projectMembers.role, "owner"),
        isNull(t.projects.deletedAt),
        sql`not exists (
          select 1 from ${t.projectMembers} other
          where other.project_id = ${t.projectMembers.projectId}
            and other.role = 'owner' and other.user_id <> ${targetId}
        )`,
      ),
    );
  return row?.count ?? 0;
}

export async function updateLocale(db: Db, user: AuthUser, locale: "ja" | "en"): Promise<AuthUser> {
  await db.update(t.users).set({ locale }).where(eq(t.users.id, user.id));
  return { ...user, locale };
}

export type BootstrapResult = "created" | "promoted" | "skipped";

/**
 * 最初の管理者を登録する(03 6章、04 3章 Step 7)。有効な管理者が1人でもいれば何もしない。
 * 同じメールの利用者が既にいれば、有効な管理者にする。
 */
export async function bootstrapAdmin(db: Db, email: string): Promise<BootstrapResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ADMIN_LOCK_KEY})`);
    if ((await countActiveAdmins(tx)) > 0) return "skipped";
    const [existing] = await tx
      .select({ id: t.users.id })
      .from(t.users)
      .where(eq(t.users.email, email));
    if (existing) {
      await tx
        .update(t.users)
        .set({ globalRole: "admin", status: "active" })
        .where(eq(t.users.id, existing.id));
      return "promoted";
    }
    await tx.insert(t.users).values({ email, globalRole: "admin" });
    return "created";
  });
}
