import { Elysia } from "elysia";
import type { Config } from "./lib/config";

export function createApp(config: Config) {
  return new Elysia({ prefix: "/api" }).get("/healthz", () => ({
    status: "ok" as const,
    version: config.appVersion,
  }));
}

export type App = ReturnType<typeof createApp>;
