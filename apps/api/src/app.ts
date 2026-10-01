import { Elysia } from "elysia";
import type { AppDeps } from "./lib/deps";
import { httpBase } from "./lib/http";
import { adminUserRoutes } from "./routes/admin-users";
import { meRoutes } from "./routes/me";
import { projectRoutes } from "./routes/projects";
import { devRoutes, logoutRoutes } from "./routes/session";
import { systemRoutes } from "./routes/system";

export function createApp(deps: AppDeps) {
  return new Elysia({ prefix: "/api" })
    .use(httpBase(deps))
    .use(systemRoutes(deps))
    .use(logoutRoutes(deps))
    .use(devRoutes(deps))
    .use(meRoutes(deps))
    .use(projectRoutes(deps))
    .use(adminUserRoutes(deps));
}

export type App = ReturnType<typeof createApp>;
