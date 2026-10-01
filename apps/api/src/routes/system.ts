import { sql } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { optionalUserId } from "../auth/session";
import type { AppDeps } from "../lib/deps";
import { AppError } from "../lib/errors";
import { requestState } from "../lib/http";

const CLIENT_MESSAGE_MAX = 500;
const CLIENT_STACK_MAX = 4000;
const CLIENT_PATH_MAX = 500;

/** 稼働確認・設定・画面のエラーの受け取り(02-01 5.3・5.10)。認証は要らない */
export function systemRoutes(deps: AppDeps) {
  const { config, db, logger } = deps;
  return new Elysia()
    .get("/healthz", () => ({ status: "ok" as const, version: config.appVersion }))
    .get("/readyz", async () => {
      try {
        await db.execute(sql`select 1`);
      } catch (cause) {
        throw new AppError("SERVICE_UNAVAILABLE", { cause });
      }
      return { status: "ok" as const };
    })
    .get("/config", () => ({
      devLogin: config.devLoginEnabled,
      picker: config.picker,
      version: config.appVersion,
    }))
    .post(
      "/client-errors",
      async ({ body, request, set }) => {
        const state = requestState(request);
        // ログイン画面やエラー画面からも送れるよう、セッションが無くても受け付ける
        const userId = (await optionalUserId(deps, request)) ?? state.userId;
        // 検索語や ID が URL に入りうるので、検索パラメーターとハッシュは落とす(02-01 7章「ログ」)
        const path = (body.path.split(/[?#]/)[0] ?? "").slice(0, CLIENT_PATH_MAX);
        // Error Reporting が拾わないよう、message にエラーの文面を入れず、スタックも stack_trace に入れない
        logger.error("client_error", {
          event: "client_error",
          requestId: state.id,
          userId,
          clientMessage: body.message.slice(0, CLIENT_MESSAGE_MAX),
          clientStack: body.stack?.slice(0, CLIENT_STACK_MAX),
          path,
        });
        set.status = 204;
      },
      { body: t.Object({ message: t.String(), stack: t.Optional(t.String()), path: t.String() }) },
    );
}
