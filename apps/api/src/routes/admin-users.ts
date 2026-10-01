import { validateEmail } from "@weaponx/shared";
import { Elysia, t } from "elysia";
import { adminAuthenticated } from "../auth/session";
import { createUser, listUsers, soleOwnerCount, updateUser } from "../domain/users";
import type { AppDeps } from "../lib/deps";
import { validationFailed } from "../lib/errors";
import { FieldCollector } from "../lib/fields";

const UserParams = t.Object({ userId: t.String() });

/** 利用者管理(02-01 5.9)。管理者だけ */
export function adminUserRoutes(deps: AppDeps) {
  const { db } = deps;
  return new Elysia({ prefix: "/admin/users" })
    .use(adminAuthenticated(deps))
    .get("/", async () => ({ users: await listUsers(db) }))
    .post(
      "/",
      async ({ auth, body, set }) => {
        const fields = new FieldCollector();
        const email = fields.take("email", validateEmail(body.email));
        fields.done();
        const user = await createUser(db, auth.user.id, email, body.admin ?? false);
        set.status = 201;
        return { user };
      },
      { body: t.Object({ email: t.String(), admin: t.Optional(t.Boolean()) }) },
    )
    .patch(
      "/:userId",
      async ({ auth, params, body }) => {
        if (body.status === undefined && body.globalRole === undefined) {
          throw validationFailed({ status: "required" });
        }
        return { user: await updateUser(db, auth.user.id, params.userId, body) };
      },
      {
        params: UserParams,
        body: t.Object({
          status: t.Optional(t.Union([t.Literal("active"), t.Literal("suspended")])),
          globalRole: t.Optional(t.Union([t.Literal("member"), t.Literal("admin")])),
        }),
      },
    )
    .get(
      "/:userId/sole-owner-count",
      async ({ params }) => ({ count: await soleOwnerCount(db, params.userId) }),
      { params: UserParams },
    );
}
