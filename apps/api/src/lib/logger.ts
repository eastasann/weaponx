type Severity = "DEBUG" | "INFO" | "WARN" | "ERROR";
export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * ログに出してよい項目(docs/05_operation-runbook.md 1章)。
 * 資料名・リンク・メール・トークン・Cookie・リクエスト本文は出さない(02-01 7章「ログ」)ので、
 * 任意のオブジェクトを受け取らず、項目を型で限る。
 */
export type LogFields = {
  event?: string;
  requestId?: string;
  userId?: string;
  route?: string;
  status?: number;
  durationMs?: number;
  code?: string;
  port?: number;
  stack_trace?: string;
  clientMessage?: string;
  clientStack?: string;
  path?: string;
  detail?: string;
};

export type Logger = {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
};

export type LoggerOptions = {
  level: LogLevel;
  /** 空なら `logging.googleapis.com/trace` を出さない */
  gcpProjectId?: string;
  write?: (line: string) => void;
};

/** 構造化 JSON を標準出力へ書くロガー(Cloud Logging が `severity` を読む) */
export function createLogger(options: LoggerOptions): Logger {
  const write = options.write ?? ((line: string) => console.log(line));
  const emit = (severity: Severity, message: string, fields: LogFields = {}) => {
    if (ORDER[severity.toLowerCase() as LogLevel] < ORDER[options.level]) return;
    const entry: Record<string, unknown> = { severity, message, ...fields };
    if (options.gcpProjectId && fields.requestId) {
      entry["logging.googleapis.com/trace"] =
        `projects/${options.gcpProjectId}/traces/${fields.requestId}`;
    }
    write(JSON.stringify(entry));
  };
  return {
    debug: (m, f) => emit("DEBUG", m, f),
    info: (m, f) => emit("INFO", m, f),
    warn: (m, f) => emit("WARN", m, f),
    error: (m, f) => emit("ERROR", m, f),
  };
}
