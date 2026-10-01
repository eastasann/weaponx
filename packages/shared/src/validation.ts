import { LIMITS } from "./limits";

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
