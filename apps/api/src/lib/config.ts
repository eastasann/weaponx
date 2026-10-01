import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const Bool = Type.Union([Type.Literal("true"), Type.Literal("false")]);

const ConfigSchema = Type.Object({
  NODE_ENV: Type.Union([
    Type.Literal("development"),
    Type.Literal("test"),
    Type.Literal("production"),
  ]),
  PORT: Type.String({ pattern: "^[0-9]{1,5}$" }),
  LOG_LEVEL: Type.Union([
    Type.Literal("debug"),
    Type.Literal("info"),
    Type.Literal("warn"),
    Type.Literal("error"),
  ]),
  APP_VERSION: Type.String({ minLength: 1 }),
  DATABASE_URL: Type.String({ pattern: "^postgres(ql)?://.+" }),
  DEV_LOGIN_ENABLED: Bool,
  DRIVE_MODE: Type.Union([Type.Literal("mock"), Type.Literal("google")]),
});

export type Config = {
  nodeEnv: Static<typeof ConfigSchema>["NODE_ENV"];
  port: number;
  logLevel: Static<typeof ConfigSchema>["LOG_LEVEL"];
  appVersion: string;
  databaseUrl: string;
  devLoginEnabled: boolean;
  driveMode: Static<typeof ConfigSchema>["DRIVE_MODE"];
};

/**
 * 環境変数を検証して設定にする。不正な値があれば起動を止める。
 * 本番で開発用ログインまたはドライブの模擬が有効なら起動しない(02-01 5.10)。
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const input = {
    NODE_ENV: env.NODE_ENV ?? "development",
    PORT: env.PORT ?? "3000",
    LOG_LEVEL: env.LOG_LEVEL ?? "info",
    APP_VERSION: env.APP_VERSION ?? "dev",
    DATABASE_URL: env.DATABASE_URL ?? "",
    DEV_LOGIN_ENABLED: env.DEV_LOGIN_ENABLED || "false",
    DRIVE_MODE: env.DRIVE_MODE || "mock",
  };

  // 値には秘密が入りうるので、変数名だけを出す
  const invalid = new Set([...Value.Errors(ConfigSchema, input)].map((e) => e.path.slice(1)));
  if (Number(input.PORT) > 65535) invalid.add("PORT");
  if (invalid.size > 0) {
    throw new Error(`環境変数が不正です: ${[...invalid].join(", ")}`);
  }

  const config: Config = {
    nodeEnv: input.NODE_ENV as Config["nodeEnv"],
    port: Number(input.PORT),
    logLevel: input.LOG_LEVEL as Config["logLevel"],
    appVersion: input.APP_VERSION,
    databaseUrl: input.DATABASE_URL,
    devLoginEnabled: input.DEV_LOGIN_ENABLED === "true",
    driveMode: input.DRIVE_MODE as Config["driveMode"],
  };

  if (config.nodeEnv === "production" && (config.devLoginEnabled || config.driveMode === "mock")) {
    throw new Error("本番では DEV_LOGIN_ENABLED=true と DRIVE_MODE=mock は使えません");
  }
  return config;
}
