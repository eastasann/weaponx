import type { Db } from "../db/client";
import type { Config } from "./config";
import type { Logger } from "./logger";

/** ルートとドメインの関数に渡す依存。アプリのメモリに正しさに関わる状態は持たない(ADR-013) */
export type AppDeps = { config: Config; db: Db; logger: Logger };
