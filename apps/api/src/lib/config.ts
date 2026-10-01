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
  APP_ORIGIN: Type.String({ pattern: "^https?://[^/?#]+$" }),
  GCP_PROJECT_ID: Type.String(),
  TOKEN_ENCRYPTION_KEYS: Type.String(),
  GOOGLE_PICKER_API_KEY: Type.String(),
  GOOGLE_PROJECT_NUMBER: Type.String(),
  DATABASE_URL: Type.String({ pattern: "^postgres(ql)?://.+" }),
  DEV_LOGIN_ENABLED: Bool,
  DRIVE_MODE: Type.Union([Type.Literal("mock"), Type.Literal("google")]),
});

export type Config = {
  nodeEnv: Static<typeof ConfigSchema>["NODE_ENV"];
  port: number;
  logLevel: Static<typeof ConfigSchema>["LOG_LEVEL"];
  appVersion: string;
  /** 画面のオリジン(末尾のスラッシュなし)。CSRF の Origin の照合に使う */
  appOrigin: string;
  /** 空ならログの trace を出さない(02-01 8章) */
  gcpProjectId: string;
  /** Cookie に Secure を付けるか。ローカルの http では付けない */
  secureCookies: boolean;
  /** Google Picker 用。`driveMode` が `google` のときだけ値が入る */
  picker: { apiKey: string; appId: string } | null;
  databaseUrl: string;
  devLoginEnabled: boolean;
  driveMode: Static<typeof ConfigSchema>["DRIVE_MODE"];
};

/**
 * `{鍵ID}:{32バイトの base64}` をカンマで区切った並び(ADR-012)の形式を確かめる。
 * 値は秘密なので、不正でもエラーに出さない。
 */
function isValidTokenEncryptionKeys(raw: string): boolean {
  const entries = raw.split(",");
  return entries.every((entry) => {
    const [id, key, ...rest] = entry.split(":");
    return (
      rest.length === 0 &&
      !!id &&
      /^[A-Za-z0-9_-]+$/.test(id) &&
      !!key &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(key) &&
      Buffer.from(key, "base64").length === 32
    );
  });
}

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
    APP_ORIGIN: env.APP_ORIGIN ?? "",
    GCP_PROJECT_ID: env.GCP_PROJECT_ID ?? "",
    TOKEN_ENCRYPTION_KEYS: env.TOKEN_ENCRYPTION_KEYS ?? "",
    GOOGLE_PICKER_API_KEY: env.GOOGLE_PICKER_API_KEY ?? "",
    GOOGLE_PROJECT_NUMBER: env.GOOGLE_PROJECT_NUMBER ?? "",
    DATABASE_URL: env.DATABASE_URL ?? "",
    DEV_LOGIN_ENABLED: env.DEV_LOGIN_ENABLED || "false",
    DRIVE_MODE: env.DRIVE_MODE || "mock",
  };

  // 値には秘密が入りうるので、変数名だけを出す
  const invalid = new Set([...Value.Errors(ConfigSchema, input)].map((e) => e.path.slice(1)));
  if (Number(input.PORT) > 65535) invalid.add("PORT");
  if (!isValidTokenEncryptionKeys(input.TOKEN_ENCRYPTION_KEYS))
    invalid.add("TOKEN_ENCRYPTION_KEYS");
  if (input.DRIVE_MODE === "google") {
    if (!input.GOOGLE_PICKER_API_KEY) invalid.add("GOOGLE_PICKER_API_KEY");
    if (!input.GOOGLE_PROJECT_NUMBER) invalid.add("GOOGLE_PROJECT_NUMBER");
  }
  if (invalid.size > 0) {
    throw new Error(`環境変数が不正です: ${[...invalid].join(", ")}`);
  }

  const config: Config = {
    nodeEnv: input.NODE_ENV as Config["nodeEnv"],
    port: Number(input.PORT),
    logLevel: input.LOG_LEVEL as Config["logLevel"],
    appVersion: input.APP_VERSION,
    appOrigin: input.APP_ORIGIN,
    gcpProjectId: input.GCP_PROJECT_ID,
    secureCookies: input.APP_ORIGIN.startsWith("https://"),
    picker:
      input.DRIVE_MODE === "google"
        ? { apiKey: input.GOOGLE_PICKER_API_KEY, appId: input.GOOGLE_PROJECT_NUMBER }
        : null,
    databaseUrl: input.DATABASE_URL,
    devLoginEnabled: input.DEV_LOGIN_ENABLED === "true",
    driveMode: input.DRIVE_MODE as Config["driveMode"],
  };

  if (config.nodeEnv === "production" && (config.devLoginEnabled || config.driveMode === "mock")) {
    throw new Error("本番では DEV_LOGIN_ENABLED=true と DRIVE_MODE=mock は使えません");
  }
  return config;
}
