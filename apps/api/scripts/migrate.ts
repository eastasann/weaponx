/**
 * マイグレーションの適用。本番の Cloud Run ジョブ weaponx-migrate もこれを使う(ADR-009)。
 * 環境変数の検証は通さない: ジョブには DATABASE_URL しか渡さないため。
 */
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL が設定されていません");
  process.exit(1);
}

/** ジョブの再実行や手動実行が重なっても、マイグレーションを同時に流さないための advisory lock のキー */
const MIGRATE_LOCK_KEY = 7_426_001;

// ロックは接続に紐づくので、ロックとマイグレーションを同じ1接続で行う。
// onnotice は CREATE EXTENSION IF NOT EXISTS などの NOTICE をジョブのログに出さないため
const sql = postgres(url, { max: 1, connect_timeout: 10, onnotice: () => {} });
try {
  await sql`SELECT pg_advisory_lock(${MIGRATE_LOCK_KEY})`;
  await migrate(drizzle(sql), { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
  console.log("マイグレーションを適用しました");
} finally {
  await sql.end();
}
