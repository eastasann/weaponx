import { LIMITS, normalizeKey } from "@weaponx/shared";
import { and, asc, eq, ilike, notExists, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import * as t from "../db/schema";
import { AppError, isUniqueViolation, parseUuid } from "../lib/errors";
import { lockProjectAndRequireRole, type ProjectRole, requireProjectRole } from "./projects";

export type Member = {
  userId: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  status: "active" | "suspended";
  hasLoggedIn: boolean;
  role: ProjectRole;
  addedAt: string;
};

export type MemberCandidate = { id: string; email: string; displayName: string | null };

const ROLE_ORDER: Record<ProjectRole, number> = { owner: 0, editor: 1, viewer: 2 };

const memberColumns = {
  userId: t.users.id,
  email: t.users.email,
  displayName: t.users.displayName,
  avatarUrl: t.users.avatarUrl,
  status: t.users.status,
  googleSubject: t.users.googleSubject,
  role: t.projectMembers.role,
  addedAt: t.projectMembers.createdAt,
};

function toMember(row: {
  userId: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  status: "active" | "suspended";
  googleSubject: string | null;
  role: ProjectRole;
  addedAt: Date;
}): Member {
  const { googleSubject, addedAt, ...rest } = row;
  return { ...rest, hasLoggedIn: googleSubject !== null, addedAt: addedAt.toISOString() };
}

async function findMember(db: Pick<Db, "select">, projectId: string, userId: string) {
  const [row] = await db
    .select(memberColumns)
    .from(t.projectMembers)
    .innerJoin(t.users, eq(t.users.id, t.projectMembers.userId))
    .where(and(eq(t.projectMembers.projectId, projectId), eq(t.projectMembers.userId, userId)));
  return row ? toMember(row) : undefined;
}

/** オーナー、編集者、閲覧者の順。同じ役割の中は名前順(名前が無ければメール) */
export async function listMembers(db: Db, userId: string, projectId: string): Promise<Member[]> {
  await requireProjectRole(db, userId, projectId, "viewer");
  const rows = await db
    .select(memberColumns)
    .from(t.projectMembers)
    .innerJoin(t.users, eq(t.users.id, t.projectMembers.userId))
    .where(eq(t.projectMembers.projectId, projectId))
    .orderBy(asc(t.users.email));
  const collator = new Intl.Collator("ja");
  return rows
    .map(toMember)
    .sort(
      (a, b) =>
        ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
        collator.compare(a.displayName ?? a.email, b.displayName ?? b.email),
    );
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

/** 有効な利用者のうち、まだメンバーでない人(名前かメールの部分一致)。件数の上限は design-spec 6.0.3 */
export async function listMemberCandidates(
  db: Db,
  userId: string,
  projectId: string,
  query: string,
): Promise<MemberCandidate[]> {
  await requireProjectRole(db, userId, projectId, "owner");
  const conditions = [
    eq(t.users.status, "active"),
    notExists(
      db
        .select({ one: sql`1` })
        .from(t.projectMembers)
        .where(
          and(eq(t.projectMembers.projectId, projectId), eq(t.projectMembers.userId, t.users.id)),
        ),
    ),
  ];
  if (query !== "") {
    const pattern = `%${escapeLike(normalizeKey(query))}%`;
    const match = or(ilike(t.users.displayName, pattern), ilike(t.users.email, pattern));
    if (match) conditions.push(match);
  }
  return db
    .select({ id: t.users.id, email: t.users.email, displayName: t.users.displayName })
    .from(t.users)
    .where(and(...conditions))
    .orderBy(asc(sql`coalesce(${t.users.displayName}, ${t.users.email})`), asc(t.users.email))
    .limit(LIMITS.candidates);
}

export async function addMember(
  db: Db,
  actorId: string,
  projectId: string,
  targetUserId: string,
  role: ProjectRole,
): Promise<Member> {
  return db.transaction(async (tx) => {
    await lockProjectAndRequireRole(tx, actorId, projectId, "owner");
    const targetId = parseUuid(targetUserId, "NOT_FOUND");
    const [target] = await tx
      .select({ status: t.users.status })
      .from(t.users)
      .where(eq(t.users.id, targetId));
    if (!target) throw new AppError("NOT_FOUND");
    if (target.status === "suspended") {
      throw new AppError("USER_SUSPENDED", { details: { userId: targetId } });
    }
    try {
      await tx
        .insert(t.projectMembers)
        .values({ projectId, userId: targetId, role, addedBy: actorId });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppError("ALREADY_MEMBER", { details: { userId: targetId } });
      }
      throw error;
    }
    const member = await findMember(tx, projectId, targetId);
    if (!member) throw new Error("追加したメンバーが見つかりません");
    return member;
  });
}

async function ownerCount(tx: Pick<Db, "select">, projectId: string): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(t.projectMembers)
    .where(and(eq(t.projectMembers.projectId, projectId), eq(t.projectMembers.role, "owner")));
  return row?.count ?? 0;
}

/** 同じ役割への変更は成功として扱う(design-spec 6.0.6)。最後のオーナーは下げられない */
export async function changeMemberRole(
  db: Db,
  actorId: string,
  projectId: string,
  targetUserId: string,
  role: ProjectRole,
): Promise<Member> {
  return db.transaction(async (tx) => {
    await lockProjectAndRequireRole(tx, actorId, projectId, "owner");
    const targetId = parseUuid(targetUserId, "MEMBER_NOT_FOUND");
    const current = await findMember(tx, projectId, targetId);
    if (!current) throw new AppError("MEMBER_NOT_FOUND");
    if (current.role === role) return current;
    if (current.role === "owner" && (await ownerCount(tx, projectId)) <= 1) {
      throw new AppError("LAST_OWNER");
    }
    await tx
      .update(t.projectMembers)
      .set({ role })
      .where(and(eq(t.projectMembers.projectId, projectId), eq(t.projectMembers.userId, targetId)));
    return { ...current, role };
  });
}

/** メンバーから外す。自分を外すこともできるが、最後のオーナーは外せない */
export async function removeMember(
  db: Db,
  actorId: string,
  projectId: string,
  targetUserId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockProjectAndRequireRole(tx, actorId, projectId, "owner");
    const targetId = parseUuid(targetUserId, "MEMBER_NOT_FOUND");
    const current = await findMember(tx, projectId, targetId);
    if (!current) throw new AppError("MEMBER_NOT_FOUND");
    if (current.role === "owner" && (await ownerCount(tx, projectId)) <= 1) {
      throw new AppError("LAST_OWNER");
    }
    await tx
      .delete(t.projectMembers)
      .where(and(eq(t.projectMembers.projectId, projectId), eq(t.projectMembers.userId, targetId)));
  });
}
