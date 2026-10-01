import type { Db } from "../db/client";
import type { Config } from "../lib/config";
import type { Logger } from "../lib/logger";
import { createGoogleDrive } from "./google";
import { createMockDrive } from "./mock";
import type { Drive } from "./types";

export { createGoogleDrive } from "./google";
export { createMockDrive, isMockDrive, type MockDrive } from "./mock";
export * from "./types";

/** `DRIVE_MODE` に応じたドライブを作る */
export function createDrive(
  config: Pick<Config, "driveMode" | "tokenKeys" | "google">,
  db: Db,
  logger: Logger,
): Drive {
  return config.driveMode === "mock"
    ? createMockDrive(db)
    : createGoogleDrive({ config, db, logger });
}
