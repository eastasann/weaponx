import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type DocumentKind,
  detectKind,
  type FieldError,
  LIMITS,
  parseDriveLink,
  validateSingleLine,
  validateSourceModifiedAt,
  validateUrl,
} from "@weaponx/shared";
import { type FormEvent, type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/Button";
import { TextField } from "../../components/TextField";
import { client, unwrap } from "../../lib/api";
import { describeError, fieldErrors, toApiError } from "../../lib/errors";
import { formatDate } from "../../lib/format";
import { meQuery } from "../../lib/queries";
import { useDebouncedValue } from "../../lib/use-debounced-value";
import { useLocale } from "../../lib/use-locale";
import { dateToIso, SELECT, today, useCloseOnFailure } from "./dialog-support";
import { duplicateOf, endsSession } from "./failure";
import { useFilePicker } from "./file-picker";
import { DriveGuidance, FailureAlert, ReauthNotice } from "./notices";
import { type ReferenceChip, ReferencePicker } from "./ReferencePicker";

const KINDS: DocumentKind[] = ["google_doc", "google_slides", "google_sheets", "pdf", "other"];

/** リンクの入力から組み立てた、登録・編集の共通の項目 */
export type LinkBody = {
  url: string;
  name: string;
  kind: DocumentKind;
  sourceModifiedAt: string | null;
  referenceIds: string[];
};

/** 編集ダイアログが渡す、保存済みの値(design-spec 6.5.6) */
export type SavedLink = {
  url: string;
  name: string;
  kind: DocumentKind;
  sourceModifiedAt: string | null;
  /** Google から取得した記録がある版。リンクを変えない間、資料名と更新日時は読み取り専用 */
  nameLocked: boolean;
};

type LookupStatus = "none" | "loading" | "ok" | "inaccessible" | "reauth" | "failed";

type Props = {
  projectId: string;
  /** 候補から除く系列(新しい版の登録・登録内容の編集の、その系列自身) */
  excludeSeriesId?: string;
  url: string;
  onUrl: (url: string) => void;
  name: string;
  onName: (name: string) => void;
  kindOverride: DocumentKind | null;
  onKind: (kind: DocumentKind) => void;
  date: string;
  onDate: (date: string) => void;
  references: ReferenceChip[];
  onReferences: (next: ReferenceChip[]) => void;
  referenceError: string | undefined;
  referenceIds: string[];
  /** 外した参考資料があれば true(文言と欄の表示は呼び出し元が持つ) */
  removeUnavailable: (error: unknown) => boolean;
  pending: boolean;
  setPending: (pending: boolean) => void;
  onClose: () => void;
  /** 重複した資料を選ぶ */
  onSelectExisting: (target: { seriesId: string; documentId: string }) => void;
  submitLabel: string;
  /**
   * 送信。成功したあとの動き(通知・閉じる・選ぶ)も呼び出し側が行い、失敗は投げる。
   * `locked` は資料名と更新日時が読み取り専用のまま(送らない)であること
   */
  submit: (body: LinkBody, context: { locked: boolean }) => Promise<void>;
  /** 編集のとき、保存済みの値。リンクを変えるまで自動取得はしない */
  saved?: SavedLink;
  /** リンク・資料名・更新日時のあとに出す欄(変更メモ・タグ) */
  extraFields?: ReactNode;
  /** 追加の欄の入力が正しいか */
  extraValid?: boolean;
  /** 追加の欄のサーバーの検証エラーを受ける。受けたら true */
  onFieldErrors?: (fields: Record<string, FieldError>) => boolean;
};

/**
 * リンクで登録・編集する入力欄(design-spec 6.2・6.5.5・6.5.6)。リンクの種別の判定、Google の資料の
 * 資料名と更新日時の自動取得、重複の表示、参考資料までをこの部品が持つ。入力の状態は呼び出し側が持つ
 */
export function LinkForm({
  projectId,
  excludeSeriesId,
  url,
  onUrl,
  name,
  onName,
  kindOverride,
  onKind,
  date,
  onDate,
  references,
  onReferences,
  referenceError,
  referenceIds,
  removeUnavailable,
  pending,
  setPending,
  onClose,
  onSelectExisting,
  submitLabel,
  submit,
  saved,
  extraFields,
  extraValid = true,
  onFieldErrors,
}: Props) {
  const { t } = useTranslation();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const { data: me } = useQuery(meQuery);
  const closeOnFailure = useCloseOnFailure(onClose);
  const driveActive = me?.drive.status === "active";
  const { pick, picking, element } = useFilePicker();

  const [touched, setTouched] = useState({ url: false, name: false });
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [duplicate, setDuplicate] = useState<ReturnType<typeof duplicateOf>>(null);
  const [alert, setAlert] = useState<string | null>(null);

  const urlResult = validateUrl(url);
  const drive = urlResult.ok ? parseDriveLink(urlResult.value) : null;
  const urlChanged = !saved || (urlResult.ok && urlResult.value !== saved.url);
  // 取得済みの版は、リンクを変えない間は資料名と更新日時を読み取り専用にする(design-spec 6.5.6)
  const locked = Boolean(saved?.nameLocked) && !urlChanged;
  const lookupWanted = drive !== null && urlChanged;
  const debouncedUrl = useDebouncedValue(urlResult.ok ? urlResult.value : "");
  const fileId = drive?.googleFileId;
  const settled = urlResult.ok && debouncedUrl === urlResult.value;

  const lookup = useQuery({
    queryKey: ["drive-file", fileId],
    queryFn: () => unwrap(client.api.drive["file-info"].post({ url: debouncedUrl })),
    enabled: lookupWanted && driveActive && settled,
    retry: false,
    gcTime: 0,
  });

  let status: LookupStatus = "none";
  if (lookupWanted) {
    if (!driveActive) status = "reauth";
    else if (!settled || lookup.isPending) status = "loading";
    else if (lookup.isSuccess) status = "ok";
    else {
      const code = toApiError(lookup.error).code;
      status =
        code === "DRIVE_FILE_NOT_ACCESSIBLE"
          ? "inaccessible"
          : code === "DRIVE_REAUTH_REQUIRED"
            ? "reauth"
            : "failed";
    }
  }
  const info = status === "ok" ? lookup.data : undefined;
  const readOnly = info !== undefined || locked;

  const kind: DocumentKind =
    info?.kind ??
    (locked ? saved?.kind : undefined) ??
    kindOverride ??
    (urlResult.ok ? detectKind(url) : "other");
  const nameValue = info?.name ?? (locked ? saved?.name : undefined) ?? name;
  const nameResult = validateSingleLine(nameValue, { max: LIMITS.documentName });
  const isoDate = info
    ? info.modifiedAt
    : locked
      ? (saved?.sourceModifiedAt ?? null)
      : dateToIso(date);
  const dateResult = !readOnly && isoDate ? validateSourceModifiedAt(isoDate) : null;

  const urlError = touched.url && !urlResult.ok ? urlResult.error : undefined;
  const nameError = touched.name && !readOnly && !nameResult.ok ? nameResult.error : undefined;

  const pickFile = async () => {
    try {
      const picked = await pick();
      if (!picked) return;
      const file = await queryClient.fetchQuery({
        queryKey: ["drive-file", picked],
        queryFn: () => unwrap(client.api.drive["file-info"].post({ fileId: picked })),
        staleTime: 0,
      });
      onUrl(file.url);
      onName(file.name);
      setTouched({ url: true, name: true });
      setDuplicate(null);
      setServerErrors({});
    } catch (error) {
      if (!endsSession(error) && describeError(error).category !== "reauth") {
        setAlert(t(describeError(error).messageKey));
      }
    }
  };

  const loading = status === "loading";
  const canSubmit =
    urlResult.ok &&
    nameResult.ok &&
    !loading &&
    extraValid &&
    (dateResult === null || dateResult.ok) &&
    referenceIds.length <= LIMITS.referencesPerVersion;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched({ url: true, name: true });
    if (!canSubmit || !urlResult.ok || !nameResult.ok || pending) return;
    setPending(true);
    setAlert(null);
    setServerErrors({});
    setDuplicate(null);
    try {
      await submit(
        {
          url: urlResult.value,
          name: nameResult.value,
          kind,
          sourceModifiedAt: isoDate,
          referenceIds,
        },
        { locked },
      );
    } catch (error) {
      if (endsSession(error)) return;
      const existing = duplicateOf(error);
      if (existing) {
        setDuplicate(existing);
      } else if (!removeUnavailable(error) && !(await closeOnFailure(error))) {
        const fields = fieldErrors(error);
        const consumed = onFieldErrors?.(fields) ?? false;
        const next: Record<string, string> = {};
        for (const [field, code] of Object.entries(fields)) {
          next[field] = t(`errors.fields.${code}`, { max: LIMITS.documentName });
        }
        if (next.url || next.name || next.sourceModifiedAt) setServerErrors(next);
        else if (!consumed && describeError(error).category !== "reauth") {
          setAlert(t(describeError(error).messageKey));
        }
      }
    } finally {
      setPending(false);
    }
  };

  const urlMessage = urlError
    ? t(`errors.fields.${urlError}`, { max: LIMITS.url })
    : serverErrors.url;

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-[var(--space-stack-gap)]">
      {alert && <FailureAlert>{alert}</FailureAlert>}
      <div className="flex items-end gap-[var(--space-inline-gap)]">
        <div className="min-w-0 flex-1">
          <TextField
            label={t("addDocument.url")}
            value={url}
            error={duplicate ? undefined : urlMessage}
            placeholder="https://"
            onChange={(event) => {
              onUrl(event.target.value);
              setTouched((current) => ({ ...current, url: true }));
              setServerErrors({});
              setDuplicate(null);
            }}
          />
        </div>
        {driveActive && (
          <Button loading={picking} onClick={() => void pickFile()}>
            {t("addDocument.pickFromDrive")}
          </Button>
        )}
      </div>
      {duplicate && (
        <p
          role="alert"
          className="typography-caption flex flex-col gap-[var(--space-tight)] text-danger"
        >
          <span>{t("errors.DUPLICATE_LINK", { name: duplicate.name })}</span>
          <button
            type="button"
            className="w-fit text-link underline"
            onClick={() => {
              onClose();
              onSelectExisting({
                seriesId: duplicate.seriesId,
                documentId: duplicate.documentId,
              });
            }}
          >
            {t("addDocument.selectExisting")}
          </button>
        </p>
      )}

      <div className="flex flex-col gap-[var(--space-tight)]">
        <TextField
          label={t("addDocument.name")}
          value={loading ? "" : nameValue}
          readOnly={readOnly}
          disabled={loading}
          placeholder={loading ? t("common.loading") : undefined}
          error={
            nameError
              ? t(`errors.fields.${nameError}`, { max: LIMITS.documentName })
              : serverErrors.name
          }
          onChange={(event) => {
            onName(event.target.value);
            setTouched((current) => ({ ...current, name: true }));
            setServerErrors((current) => ({ ...current, name: "" }));
          }}
        />
        {info && !locked && (
          <p className="typography-caption text-text-muted">{t("addDocument.useDriveName")}</p>
        )}
        {locked && (
          <p className="typography-caption text-text-muted">{t("editDocument.lockedNote")}</p>
        )}
        {status === "inaccessible" && fileId && (
          <DriveGuidance
            fileId={fileId}
            onGranted={() => void queryClient.invalidateQueries({ queryKey: ["drive-file"] })}
          />
        )}
        {status === "failed" && (
          <p className="typography-caption text-text-muted">{t("addDocument.fetchFailed")}</p>
        )}
        {status === "reauth" && drive && <ReauthNotice message={t("addDocument.reauthFetch")} />}
      </div>

      <div className="flex gap-[var(--space-stack-gap)]">
        <label className="typography-label flex flex-col gap-[var(--space-tight)]">
          {t("addDocument.kind")}
          <select
            value={kind}
            disabled={readOnly}
            onChange={(event) => onKind(event.target.value as DocumentKind)}
            className={SELECT}
          >
            {KINDS.map((value) => (
              <option key={value} value={value}>
                {t(`kinds.${value}`)}
              </option>
            ))}
          </select>
        </label>
        {readOnly ? (
          <div className="typography-label flex flex-col gap-[var(--space-tight)]">
            {t("addDocument.modifiedAt")}
            <span className="typography-body flex h-[var(--size-control)] items-center">
              {isoDate ? formatDate(isoDate, locale) : t("common.noValue")}
            </span>
          </div>
        ) : (
          <div className="flex flex-col gap-[var(--space-tight)]">
            <label className="typography-label flex flex-col gap-[var(--space-tight)]">
              {t("addDocument.modifiedAt")}
              <input
                type="date"
                value={date}
                max={today()}
                disabled={loading}
                onChange={(event) => onDate(event.target.value)}
                className={SELECT}
              />
            </label>
            {((dateResult && !dateResult.ok) || serverErrors.sourceModifiedAt) && (
              <p role="alert" className="typography-caption text-danger">
                {dateResult && !dateResult.ok
                  ? t(`errors.fields.${dateResult.error}`)
                  : serverErrors.sourceModifiedAt}
              </p>
            )}
          </div>
        )}
      </div>

      {extraFields}
      <ReferencePicker
        projectId={projectId}
        {...(excludeSeriesId ? { excludeSeriesId } : {})}
        value={references}
        onChange={onReferences}
        error={referenceError}
      />
      <div className="flex justify-end gap-[var(--space-inline-gap)]">
        <Button disabled={pending} onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" variant="primary" loading={pending} disabled={!canSubmit}>
          {submitLabel}
        </Button>
      </div>
      {element}
    </form>
  );
}
