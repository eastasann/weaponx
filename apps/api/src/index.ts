import { createApp } from "./app";
import { createDb } from "./db/client";
import { createDrive } from "./drive";
import { loadConfig } from "./lib/config";
import { createLogger } from "./lib/logger";

const config = loadConfig();
const logger = createLogger({ level: config.logLevel, gcpProjectId: config.gcpProjectId });
const { db } = createDb(config.databaseUrl);

// 本文の上限は画面の入力(最大でも数KB)に対して十分大きく、巨大な本文でメモリを使わせないための値
createApp({ config, db, logger, drive: createDrive(config, db, logger) }).listen({
  port: config.port,
  maxRequestBodySize: 1024 * 1024,
});
logger.info("api started", { event: "startup", port: config.port });
