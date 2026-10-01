import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * 接続プールの上限。Cloud Run は最大3台で、db-f1-micro の接続上限(約25)に収めるため
 * インスタンスごとに5(02-01 7章「パフォーマンス」)。変えるときは台数との掛け算を確かめる。
 */
export const MAX_POOL_CONNECTIONS = 5;

export function createDb(databaseUrl: string) {
  // 接続できないときに、リクエストが Cloud Run のタイムアウトまで待たされないようにする
  const sql = postgres(databaseUrl, {
    max: MAX_POOL_CONNECTIONS,
    connect_timeout: 10,
    onnotice: () => {},
  });
  return { db: drizzle(sql, { schema }), sql };
}

export type Db = ReturnType<typeof createDb>["db"];
