import { useQuery } from "@tanstack/react-query";
import { type DocumentKind, LIMITS, normalizeKey } from "@weaponx/shared";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { KindIcon } from "../../components/KindIcon";
import { client, unwrap } from "../../lib/api";
import { useDebouncedValue } from "../../lib/use-debounced-value";

/**
 * 参考資料のチップ。表示は design-spec 6.1 の「関連資料の表示規則」に従う:
 * 見る権限のない資料と削除された資料は名前を持たず、固定の文言で出す
 */
export type ReferenceChip =
  | {
      key: string;
      visibility: "visible";
      documentId: string;
      name: string;
      kind: DocumentKind;
      /** 同じ案件の資料は null */
      projectName: string | null;
    }
  | { key: string; visibility: "no_access" | "deleted" };

type Props = {
  projectId: string;
  /** 候補から除く系列(新しい版を登録するときの、その系列自身) */
  excludeSeriesId?: string;
  value: ReferenceChip[];
  onChange: (next: ReferenceChip[]) => void;
  /** 欄の下に出す理由(新しく足した参考資料が見られなくなったときなど) */
  error?: string | undefined;
};

/** 参考資料の選択(design-spec 6.2)。名前で検索した候補からチップとして足し、×で外す。20件まで */
export function ReferencePicker({ projectId, excludeSeriesId, value, onChange, error }: Props) {
  const { t } = useTranslation();
  const [input, setInput] = useState("");
  const q = useDebouncedValue(input.trim());
  const listId = useId();
  const full = value.length >= LIMITS.referencesPerVersion;

  const candidates = useQuery({
    queryKey: ["reference-candidates", q, excludeSeriesId ?? null],
    queryFn: () =>
      unwrap(
        client.api["reference-candidates"].get({
          query: { q, ...(excludeSeriesId ? { excludeSeriesId } : {}) },
        }),
      ),
    enabled: q !== "" && !full,
    // 参加している案件の資料は他の画面の操作で変わるので、使い回さない
    gcTime: 0,
  });

  const chosen = new Set(
    value.flatMap((chip) => (chip.visibility === "visible" ? [chip.documentId] : [])),
  );
  const options = (candidates.data?.candidates ?? []).filter(
    (candidate) => !chosen.has(candidate.documentId),
  );
  const waiting = input.trim() !== "" && normalizeKey(input.trim()) !== normalizeKey(q);

  const add = (candidate: NonNullable<typeof candidates.data>["candidates"][number]) => {
    onChange([
      ...value,
      {
        key: candidate.documentId,
        visibility: "visible",
        documentId: candidate.documentId,
        name: candidate.name,
        kind: candidate.kind,
        projectName: candidate.projectId === projectId ? null : candidate.projectName,
      },
    ]);
    setInput("");
  };

  return (
    <div className="flex flex-col gap-[var(--space-tight)]">
      <label htmlFor={listId} className="typography-label">
        {t("references.label")}
      </label>
      <input
        id={listId}
        type="search"
        value={input}
        disabled={full}
        maxLength={LIMITS.searchQuery}
        placeholder={t("references.placeholder")}
        aria-invalid={error ? true : undefined}
        onChange={(event) => setInput(event.target.value)}
        className="typography-body h-[var(--size-control)] rounded-[var(--radius-control)] border border-border-strong bg-surface px-[var(--space-inline-gap)] text-text placeholder:text-text-subtle focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring disabled:opacity-50"
      />
      {full && (
        <p className="typography-caption text-text-muted">
          {t("references.limit", { max: LIMITS.referencesPerVersion })}
        </p>
      )}
      {q !== "" && !full && (
        <fieldset className="max-h-48 min-w-0 overflow-y-auto rounded-[var(--radius-control)] border border-border">
          <legend className="sr-only">{t("references.candidates")}</legend>
          {candidates.isError ? (
            <p role="alert" className="typography-body p-[var(--space-inline-gap)] text-text-muted">
              {t("references.loadFailed")}
            </p>
          ) : candidates.isPending || waiting ? (
            <p className="typography-body p-[var(--space-inline-gap)] text-text-muted">
              {t("common.loading")}
            </p>
          ) : options.length === 0 ? (
            <p className="typography-body p-[var(--space-inline-gap)] text-text-muted">
              {t("references.none")}
            </p>
          ) : (
            <ul>
              {options.map((candidate) => (
                <li key={candidate.documentId}>
                  <button
                    type="button"
                    onClick={() => add(candidate)}
                    className="typography-body flex w-full items-center gap-[var(--space-inline-gap)] px-[var(--space-inline-gap)] py-[var(--space-tight)] text-left hover:bg-row-hover"
                  >
                    <KindIcon kind={candidate.kind} />
                    <span className="min-w-0 break-words">{candidate.name}</span>
                    <span className="text-text-muted">
                      {t("panel.projectSuffix", { project: candidate.projectName })}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </fieldset>
      )}
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-[var(--space-inline-gap)]">
          {value.map((chip) => (
            <li
              key={chip.key}
              className="typography-body flex max-w-full items-center gap-[var(--space-tight)] rounded-[var(--radius-chip)] border border-border bg-surface-muted px-[var(--space-inline-gap)] py-[var(--space-tight)]"
            >
              <ChipLabel chip={chip} />
              <button
                type="button"
                aria-label={t("references.remove", { name: chipName(chip, t) })}
                onClick={() => onChange(value.filter((other) => other.key !== chip.key))}
                className="rounded-[var(--radius-chip)] px-[var(--space-tight)] text-text-muted hover:bg-row-hover"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="typography-caption text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function chipName(chip: ReferenceChip, t: ReturnType<typeof useTranslation>["t"]): string {
  if (chip.visibility === "visible") return chip.name;
  return chip.visibility === "no_access" ? t("panel.noAccess") : t("panel.deleted");
}

function ChipLabel({ chip }: { chip: ReferenceChip }) {
  const { t } = useTranslation();
  if (chip.visibility !== "visible") {
    return chip.visibility === "no_access" ? (
      <span className="text-text-muted">
        <span aria-hidden="true">🔒 </span>
        {t("panel.noAccess")}
      </span>
    ) : (
      <span className="text-text-muted">{t("panel.deleted")}</span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-[var(--space-tight)]">
      <KindIcon kind={chip.kind} />
      <span className="min-w-0 break-words">{chip.name}</span>
      {chip.projectName !== null && (
        <span className="text-text-muted">
          {t("panel.projectSuffix", { project: chip.projectName })}
        </span>
      )}
    </span>
  );
}
