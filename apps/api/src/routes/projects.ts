import { LIMITS } from "@weaponx/shared";
import { Elysia, t } from "elysia";
import { authenticated } from "../auth/session";
import {
  addMember,
  changeMemberRole,
  listMemberCandidates,
  listMembers,
  removeMember,
} from "../domain/members";
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  renameProject,
  requireProjectRole,
} from "../domain/projects";
import type { AppDeps } from "../lib/deps";
import { FieldCollector } from "../lib/fields";

const Role = t.Union([t.Literal("owner"), t.Literal("editor"), t.Literal("viewer")]);
const ProjectParams = t.Object({ projectId: t.String() });
const MemberParams = t.Object({ projectId: t.String(), userId: t.String() });

/** 入力の検証は認可の後(02-01 7章の判定の順) */
function projectName(raw: string): string {
  const fields = new FieldCollector();
  const name = fields.text("name", raw, { max: LIMITS.projectName });
  fields.done();
  return name;
}

/** 案件とメンバー(02-01 5.4・5.8) */
export function projectRoutes(deps: AppDeps) {
  const { db } = deps;
  return new Elysia({ prefix: "/projects" })
    .use(authenticated(deps))
    .get(
      "/",
      async ({ auth, query }) => ({
        projects: await listProjects(db, auth.user.id, query.minRole),
      }),
      { query: t.Object({ minRole: t.Optional(Role) }) },
    )
    .post(
      "/",
      async ({ auth, body, set }) => {
        const project = await createProject(db, auth.user.id, projectName(body.name));
        set.status = 201;
        return { project };
      },
      { body: t.Object({ name: t.String() }) },
    )
    .get(
      "/:projectId",
      async ({ auth, params }) => ({
        project: await getProject(db, auth.user.id, params.projectId),
      }),
      { params: ProjectParams },
    )
    .patch(
      "/:projectId",
      async ({ auth, params, body }) => {
        await requireProjectRole(db, auth.user.id, params.projectId, "owner");
        return {
          project: await renameProject(db, auth.user.id, params.projectId, projectName(body.name)),
        };
      },
      { params: ProjectParams, body: t.Object({ name: t.String() }) },
    )
    .delete(
      "/:projectId",
      async ({ auth, params, set }) => {
        await deleteProject(db, auth.user.id, params.projectId);
        set.status = 204;
      },
      { params: ProjectParams },
    )
    .get(
      "/:projectId/members",
      async ({ auth, params }) => ({
        members: await listMembers(db, auth.user.id, params.projectId),
      }),
      { params: ProjectParams },
    )
    .get(
      "/:projectId/member-candidates",
      async ({ auth, params, query }) => {
        await requireProjectRole(db, auth.user.id, params.projectId, "owner");
        const fields = new FieldCollector();
        const q = fields.text("q", query.q ?? "", { max: LIMITS.searchQuery, required: false });
        fields.done();
        return { users: await listMemberCandidates(db, auth.user.id, params.projectId, q) };
      },
      { params: ProjectParams, query: t.Object({ q: t.Optional(t.String()) }) },
    )
    .post(
      "/:projectId/members",
      async ({ auth, params, body, set }) => {
        const member = await addMember(db, auth.user.id, params.projectId, body.userId, body.role);
        set.status = 201;
        return { member };
      },
      { params: ProjectParams, body: t.Object({ userId: t.String(), role: Role }) },
    )
    .patch(
      "/:projectId/members/:userId",
      async ({ auth, params, body }) => ({
        member: await changeMemberRole(
          db,
          auth.user.id,
          params.projectId,
          params.userId,
          body.role,
        ),
      }),
      { params: MemberParams, body: t.Object({ role: Role }) },
    )
    .delete(
      "/:projectId/members/:userId",
      async ({ auth, params, set }) => {
        await removeMember(db, auth.user.id, params.projectId, params.userId);
        set.status = 204;
      },
      { params: MemberParams },
    );
}
