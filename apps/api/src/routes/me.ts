import { eq } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { authenticated } from "../auth/session";
import * as schema from "../db/schema";
import { updateLocale } from "../domain/users";
import type { AppDeps } from "../lib/deps";

/** 利用者自身と表示言語(02-01 5.3) */
export function meRoutes(deps: AppDeps) {
  const { db } = deps;
  return new Elysia({ prefix: "/me" })
    .use(authenticated(deps))
    .get("/", async ({ auth }) => {
      const [connection] = await db
        .select({ status: schema.driveConnections.status })
        .from(schema.driveConnections)
        .where(eq(schema.driveConnections.userId, auth.user.id));
      // 連携の行はログインした利用者には必ずある。無ければ許可を得ていないので、要再連携と同じに扱う
      return {
        user: auth.user,
        drive: { status: connection?.status ?? ("needs_reauth" as const) },
      };
    })
    .patch(
      "/",
      async ({ auth, body }) => ({ user: await updateLocale(db, auth.user, body.locale) }),
      { body: t.Object({ locale: t.Union([t.Literal("ja"), t.Literal("en")]) }) },
    );
}
