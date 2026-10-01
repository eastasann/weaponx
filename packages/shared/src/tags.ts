import { LIMITS } from "./limits";
import { labelKey } from "./normalize";
import { type FieldError, validateSingleLine } from "./validation";

export type Tag = { label: string; key: string };

export type TagsResult = { ok: true; value: Tag[] } | { ok: false; error: FieldError };

/**
 * 版に付けるタグの一式を検証する(design-spec 6.0.3)。各タグは前後の空白を除いた1行で、
 * 大文字・小文字、全角・半角の英数字が違うだけのタグは重複として先に入力したほうだけを残す。
 * 重複を除いた件数が上限を超えれば `too_many`。
 */
export function validateTags(raw: readonly string[]): TagsResult {
  const tags = new Map<string, Tag>();
  for (const item of raw) {
    const result = validateSingleLine(item, { max: LIMITS.tag });
    if (!result.ok) return result;
    const key = labelKey(result.value);
    if (!tags.has(key)) tags.set(key, { label: result.value, key });
  }
  if (tags.size > LIMITS.tagsPerVersion) return { ok: false, error: "too_many" };
  return { ok: true, value: [...tags.values()] };
}
