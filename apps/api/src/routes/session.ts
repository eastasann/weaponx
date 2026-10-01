import { validateEmail } from "@weaponx/shared";
import { eq, sql } from "drizzle-orm";
import { Elysia, t } from "elysia";
import {
  authenticated,
  clearSessionCookie,
  createSession,
  deleteSession,
  loginNoticeCookie,
} from "../auth/session";
import * as schema from "../db/schema";
import { appendSetCookie } from "../lib/cookies";
import type { AppDeps } from "../lib/deps";
import { AppError } from "../lib/errors";

export function logoutRoutes(deps: AppDeps) {
  return new Elysia({ prefix: "/auth" })
    .use(authenticated(deps))
    .post("/logout", async ({ request, set }) => {
      await deleteSession(deps, request);
      appendSetCookie(set, clearSessionCookie(deps));
      set.status = 204;
    });
}

/**
 * 開発用ログイン(02-01 5.10)。`DEV_LOGIN_ENABLED=true` のときだけルートを登録する。
 * 型は常に含める(画面の Eden が型を得るため)。無効なときは空のプラグインを返す。
 */
export function devRoutes(deps: AppDeps) {
  const { db, config } = deps;
  const routes = new Elysia({ prefix: "/dev" })
    // 一度でもログインした(Google アカウントの ID がある)利用者だけ。未ログインの人はドライブ連携の記録が無い
    .get("/users", async () => {
      const users = await db
        .select({
          id: schema.users.id,
          email: schema.users.email,
          displayName: schema.users.displayName,
          globalRole: schema.users.globalRole,
          status: schema.users.status,
        })
        .from(schema.users)
        .where(sql`${schema.users.googleSubject} is not null`)
        .orderBy(schema.users.email);
      return { users };
    })
    .post(
      "/login",
      async ({ body, set }) => {
        const email = validateEmail(body.email);
        const [user] = email.ok
          ? await db
              .select({
                id: schema.users.id,
                status: schema.users.status,
                googleSubject: schema.users.googleSubject,
              })
              .from(schema.users)
              .where(eq(schema.users.email, email.value))
          : [];
        if (!user || user.googleSubject === null) throw new AppError("NOT_FOUND");
        if (user.status === "suspended") {
          throw new AppError("ACCOUNT_SUSPENDED", {
            cookies: [loginNoticeCookie(deps, { code: "suspended" })],
          });
        }
        // 本物のログインと同じく最終ログインを更新する。drive_connections は更新しない(design-spec 8章)
        await db
          .update(schema.users)
          .set({ lastLoginAt: new Date() })
          .where(eq(schema.users.id, user.id));
        appendSetCookie(set, await createSession(deps, user.id));
        set.status = 204;
      },
      { body: t.Object({ email: t.String() }) },
    );
  return config.devLoginEnabled
    ? routes
    : (new Elysia({ prefix: "/dev" }) as unknown as typeof routes);
}
