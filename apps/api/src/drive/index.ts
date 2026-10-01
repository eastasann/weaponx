import type { Db } from "../db/client";
import type { Config } from "../lib/config";
import { createMockDrive } from "./mock";
import type { Drive } from "./types";

export { createMockDrive, isMockDrive, type MockDrive } from "./mock";
export * from "./types";

/**
 * `DRIVE_MODE` に応じたドライブを作る。`google` の本物は、Google の OAuth クライアントと
 * リフレッシュトークンの暗号化(ADR-012)に依存するので、`drive/google.ts` が入るまでは起動時のエラーにする。
 */
export function createDrive(config: Pick<Config, "driveMode">, db: Db): Drive {
  if (config.driveMode === "mock") return createMockDrive(db);
  throw new Error("DRIVE_MODE=google は未対応です(drive/google.ts がありません)");
}
