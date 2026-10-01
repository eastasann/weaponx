import { LIMITS } from "./limits";
import { isHttpUrl } from "./link";

/** `VALIDATION_FAILED.details.fields` の値(02-01 8章) */
export type FieldError =
  | "required"
  | "too_long"
  | "invalid_url"
  | "invalid_format"
  | "too_many"
  | "future_date"
  | "locked";

export type TextResult = { ok: true; value: string } | { ok: false; error: FieldError };

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** 見た目の1文字を1と数える(design-spec 6.0.3) */
export function countGraphemes(value: string): number {
  let count = 0;
  for (const _ of segmenter.segment(value)) count++;
  return count;
}

/**
 * 1行入力の検証。前後の空白を取り除き、空なら `required`、改行を含めば `invalid_format`、
 * 上限を超えれば `too_long`(design-spec 6.0.3)。`required: false` のときは空を `""` で受け付ける。
 */
export function validateSingleLine(
  raw: string,
  options: { max: number; required?: boolean },
): TextResult {
  const value = raw.trim();
  if (value === "") {
    return options.required === false ? { ok: true, value } : { ok: false, error: "required" };
  }
  if (/[\r\n\u2028\u2029]/.test(value)) return { ok: false, error: "invalid_format" };
  if (countGraphemes(value) > options.max) return { ok: false, error: "too_long" };
  return { ok: true, value };
}

// 実在するかは確かめない。管理者が登録したメールと Google のメールを照合するための形式の確認
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/**
 * メールアドレスの検証。前後の空白を除いて小文字にした値を返す(02-01 5.9)。
 * 長さの上限は `LIMITS.email`。
 */
export function validateEmail(raw: string): TextResult {
  const value = raw.trim().toLowerCase();
  if (value === "") return { ok: false, error: "required" };
  if (value.length > LIMITS.email) return { ok: false, error: "too_long" };
  if (!EMAIL_PATTERN.test(value)) return { ok: false, error: "invalid_format" };
  return { ok: true, value };
}

/**
 * リンクの検証。前後の空白を除いた値を返す。空なら `required`、上限を超えれば `too_long`、
 * http・https 以外(`javascript:` など)は `invalid_url`(design-spec 6.0.3)。
 */
export function validateUrl(raw: string): TextResult {
  const value = raw.trim();
  if (value === "") return { ok: false, error: "required" };
  if (countGraphemes(value) > LIMITS.url) return { ok: false, error: "too_long" };
  if (!isHttpUrl(value)) return { ok: false, error: "invalid_url" };
  return { ok: true, value };
}

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export type DateResult = { ok: true; value: Date } | { ok: false; error: FieldError };

/** 元の場所での更新日時の検証。ISO 8601 の日時だけを受け付け、未来は `future_date` */
export function validateSourceModifiedAt(raw: string, now: Date = new Date()): DateResult {
  if (!ISO_DATE_TIME.test(raw)) return { ok: false, error: "invalid_format" };
  const value = new Date(raw);
  if (Number.isNaN(value.getTime())) return { ok: false, error: "invalid_format" };
  if (value.getTime() > now.getTime()) return { ok: false, error: "future_date" };
  return { ok: true, value };
}
