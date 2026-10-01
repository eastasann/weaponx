/**
 * 最初の管理者を登録する(03_dev-setup.md 6章、04_deployment-procedure.md 3章 Step 7)。
 * `bun scripts/bootstrap-admin.ts you@example.com` か `--email=you@example.com`。
 * 有効な管理者が1人でもいれば何もしない。ログにメールは出さない(02-01 7章「ログ」)。
 * 環境変数の検証は通さない: ジョブ weaponx-migrate には DATABASE_URL しか渡さないため(migrate.ts と同じ)。
 */
import { validateEmail } from "@weaponx/shared";
import { createDb } from "../src/db/client";
import { bootstrapAdmin } from "../src/domain/users";
import { createLogger } from "../src/lib/logger";

const args = process.argv.slice(2);
const raw =
  args.find((arg) => arg.startsWith("--email="))?.slice("--email=".length) ??
  args.find((arg) => !arg.startsWith("--"));

const email = validateEmail(raw ?? "");
if (!email.ok) {
  console.error("メールアドレスを指定してください: bun scripts/bootstrap-admin.ts you@example.com");
  process.exit(2);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL が設定されていません");
  process.exit(1);
}

const logger = createLogger({ level: "info" });
const { db, sql } = createDb(databaseUrl);
try {
  const result = await bootstrapAdmin(db, email.value);
  logger.info("bootstrap-admin", { event: "bootstrap_admin", detail: result });
  if (result === "skipped") {
    console.error("有効な管理者が既にいるので、何も登録しませんでした");
    process.exitCode = 1;
  }
} finally {
  await sql.end();
}
