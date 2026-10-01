import { useQuery } from "@tanstack/react-query";
import {
  LIMITS,
  labelKey,
  type TagsResult,
  validateSingleLine,
  validateTags,
} from "@weaponx/shared";
import { type KeyboardEvent, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { client, unwrap } from "../../lib/api";
import { useDebouncedValue } from "../../lib/use-debounced-value";

type Props = {
  projectId: string;
  /** 確定済みのタグ(付けた順) */
  value: string[];
  onChange: (next: string[]) => void;
  /** Enter の前の、確定していない入力 */
  input: string;
  onInput: (next: string) => void;
  /** サーバーが返した理由(欄の下に出す) */
  error?: string | undefined;
};

/**
 * 保存するときに、確定していない入力を確定してから検証する(design-spec 6.0.3)。
 * 入力が空なら確定済みのタグだけを検証する
 */
export function finalTags(value: readonly string[], pending: string): TagsResult {
  return validateTags(pending.trim() === "" ? value : [...value, pending]);
}

/** 版のタグの入力(design-spec 6.0.3・6.5.6)。候補から選ぶか Enter で確定し、チップで並べる */
export function TagInput({ projectId, value, onChange, input, onInput, error }: Props) {
  const { t } = useTranslation();
  const inputId = useId();
  const q = useDebouncedValue(input.trim());
  const full = value.length >= LIMITS.tagsPerVersion;
  // 同じタグを入力したときに、すでにあるチップを光らせる
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    if (flash === null) return;
    const timer = setTimeout(() => setFlash(null), 1200);
    return () => clearTimeout(timer);
  }, [flash]);

  // 候補を読み込めなくても、自由に入力できる
  const candidates = useQuery({
    queryKey: ["tag-candidates", projectId, q],
    queryFn: () => unwrap(client.api.projects({ projectId }).tags.get({ query: { q } })),
    enabled: q !== "" && !full,
    retry: false,
    gcTime: 0,
  });

  const taken = new Set(value.map(labelKey));
  const options = (candidates.data?.tags ?? []).filter((tag) => !taken.has(labelKey(tag)));
  const inputResult = validateSingleLine(input, { max: LIMITS.tag, required: false });
  const inputError = input.trim() !== "" && !inputResult.ok ? inputResult.error : undefined;

  const commit = (raw: string) => {
    const result = validateSingleLine(raw, { max: LIMITS.tag, required: false });
    if (!result.ok) return;
    if (result.value === "") return;
    const key = labelKey(result.value);
    const existing = value.find((tag) => labelKey(tag) === key);
    if (existing !== undefined) {
      setFlash(existing);
    } else {
      onChange([...value, result.value]);
    }
    onInput("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    // 変換の確定の Enter では確定しない。フォームの送信にもしない
    event.preventDefault();
    if (event.nativeEvent.isComposing) return;
    commit(input);
  };

  const message = error
    ? error
    : inputError
      ? t(`errors.fields.${inputError}`, { max: LIMITS.tag })
      : undefined;

  return (
    <div className="flex flex-col gap-[var(--space-tight)]">
      <label htmlFor={inputId} className="typography-label">
        {t("tags.label")}
      </label>
      <input
        id={inputId}
        type="text"
        value={input}
        disabled={full}
        placeholder={t("tags.placeholder")}
        aria-invalid={message ? true : undefined}
        onChange={(event) => onInput(event.target.value)}
        onKeyDown={onKeyDown}
        className="typography-body h-[var(--size-control)] rounded-[var(--radius-control)] border border-border-strong bg-surface px-[var(--space-inline-gap)] text-text placeholder:text-text-subtle focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring disabled:opacity-50"
      />
      {full && (
        <p className="typography-caption text-text-muted">
          {t("tags.limit", { max: LIMITS.tagsPerVersion })}
        </p>
      )}
      {message && (
        <p role="alert" className="typography-caption text-danger">
          {message}
        </p>
      )}
      {q !== "" && !full && options.length > 0 && (
        <fieldset className="max-h-40 min-w-0 overflow-y-auto rounded-[var(--radius-control)] border border-border">
          <legend className="sr-only">{t("tags.candidates")}</legend>
          <ul>
            {options.map((tag) => (
              <li key={tag}>
                <button
                  type="button"
                  onClick={() => commit(tag)}
                  className="typography-body w-full px-[var(--space-inline-gap)] py-[var(--space-tight)] text-left hover:bg-row-hover"
                >
                  {tag}
                </button>
              </li>
            ))}
          </ul>
        </fieldset>
      )}
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-[var(--space-inline-gap)]">
          {value.map((tag) => (
            <li
              key={labelKey(tag)}
              data-flash={flash === tag ? "true" : undefined}
              className="typography-body flex max-w-full items-center gap-[var(--space-tight)] rounded-[var(--radius-chip)] border border-border bg-surface-muted px-[var(--space-inline-gap)] py-[var(--space-tight)] data-[flash=true]:border-accent data-[flash=true]:bg-selected"
            >
              <span className="min-w-0 break-words">{tag}</span>
              <button
                type="button"
                aria-label={t("tags.remove", { name: tag })}
                onClick={() => onChange(value.filter((other) => other !== tag))}
                className="rounded-[var(--radius-chip)] px-[var(--space-tight)] text-text-muted hover:bg-row-hover"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
