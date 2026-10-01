import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type DocumentKind,
  detectKind,
  LIMITS,
  parseDriveLink,
  validateSingleLine,
  validateSourceModifiedAt,
  validateUrl,
} from "@weaponx/shared";
import { Tabs } from "radix-ui";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { TextField } from "../../components/TextField";
import { useNotify } from "../../components/Toast";
import { client, unwrap } from "../../lib/api";
import { describeError, fieldErrors, toApiError } from "../../lib/errors";
import { formatDate } from "../../lib/format";
import { meQuery } from "../../lib/queries";
import { useDebouncedValue } from "../../lib/use-debounced-value";
import { useLocale } from "../../lib/use-locale";
import {
  applyDriveStatus,
  type CreatedNotRegistered,
  closesDialog,
  createdNotRegistered,
  duplicateOf,
  endsSession,
  unavailableReferenceIds,
} from "./failure";
import { useFilePicker } from "./file-picker";
import { DriveGuidance, FailureAlert, ReauthNotice } from "./notices";
import { type ReferenceChip, ReferencePicker } from "./ReferencePicker";

type CreatableKind = "google_doc" | "google_slides";
const CREATABLE: CreatableKind[] = ["google_doc", "google_slides"];
const KINDS: DocumentKind[] = ["google_doc", "google_slides", "google_sheets", "pdf", "other"];

const SELECT =
  "typography-body h-[var(--size-control)] rounded-[var(--radius-control)] border border-border-strong bg-surface px-[var(--space-inline-gap)] text-text disabled:opacity-60";

export type AddDocumentPrefill = { url: string; name: string; references: ReferenceChip[] };

type Props = {
  projectId: string;
  /** 「このリンクで登録」から開くときの、入力済みの内容(design-spec 6.0.8) */
  prefill?: AddDocumentPrefill;
  onClose: () => void;
  /** 登録できた(または重複した資料を選ぶ)とき、その系列と版を選ぶ */
  onSelect: (target: { seriesId: string; documentId: string }) => void;
};

/** 今日の日付(ブラウザのタイムゾーン)。未来の日付を選べなくする上限 */
function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 日付ピッカーの値を、ブラウザのタイムゾーンの0時として UTC の日時にする(design-spec 6.2) */
function dateToIso(date: string): string | null {
  return date ? new Date(`${date}T00:00:00`).toISOString() : null;
}

/** 資料を追加ダイアログ(design-spec 6.2)。「新しく作る」(既定)と「リンクで登録」 */
export function AddDocumentDialog({ projectId, prefill, onClose, onSelect }: Props) {
  const { t } = useTranslation();
  const { data: me } = useQuery(meQuery);
  const needsReauth = me?.drive.status === "needs_reauth";
  const [tab, setTab] = useState<"create" | "link">(prefill || needsReauth ? "link" : "create");
  const [references, setReferences] = useState<ReferenceChip[]>(prefill?.references ?? []);
  const [referenceError, setReferenceError] = useState<string | undefined>();
  const [createdFailure, setCreatedFailure] = useState<CreatedNotRegistered | null>(null);
  const [pending, setPending] = useState(false);

  // 「新しく作る」の入力
  const [createKind, setCreateKind] = useState<CreatableKind>("google_doc");
  const [createName, setCreateName] = useState(prefill?.name ?? "");
  // 「リンクで登録」の入力
  const [url, setUrl] = useState(prefill?.url ?? "");
  const [linkName, setLinkName] = useState(prefill?.name ?? "");
  const [kindOverride, setKindOverride] = useState<DocumentKind | null>(null);
  const [date, setDate] = useState("");

  const referenceIds = references.flatMap((chip) =>
    chip.visibility === "visible" ? [chip.documentId] : [],
  );

  const removeUnavailable = (error: unknown) => {
    const gone = unavailableReferenceIds(error);
    if (gone.length === 0) return false;
    const names = references.flatMap((chip) =>
      chip.visibility === "visible" && gone.includes(chip.documentId) ? [chip.name] : [],
    );
    setReferences((current) =>
      current.filter((chip) => chip.visibility !== "visible" || !gone.includes(chip.documentId)),
    );
    setReferenceError(
      names.map((name) => t("errors.REFERENCE_UNAVAILABLE", { name })).join(" ") || undefined,
    );
    return true;
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !pending && onClose()}
      title={t("addDocument.title")}
    >
      <Tabs.Root
        value={tab}
        onValueChange={(next) => setTab(next as "create" | "link")}
        className="flex flex-col gap-[var(--space-stack-gap)]"
      >
        <Tabs.List
          aria-label={t("addDocument.title")}
          className="flex gap-[var(--space-inline-gap)] border-b border-border"
        >
          {(["create", "link"] as const).map((value) => (
            <Tabs.Trigger
              key={value}
              value={value}
              disabled={pending}
              className="typography-label -mb-px border-b-2 border-transparent px-[var(--space-stack-gap)] py-[var(--space-inline-gap)] text-text-muted data-[state=active]:border-accent data-[state=active]:text-text"
            >
              {t(`addDocument.tabs.${value}`)}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <Tabs.Content value="create" forceMount hidden={tab !== "create"}>
          <CreateTab
            projectId={projectId}
            kind={createKind}
            onKind={setCreateKind}
            name={createName}
            onName={setCreateName}
            references={references}
            onReferences={(next) => {
              setReferences(next);
              setReferenceError(undefined);
            }}
            referenceError={referenceError}
            referenceIds={referenceIds}
            removeUnavailable={removeUnavailable}
            createdFailure={createdFailure}
            onCreatedFailure={setCreatedFailure}
            onRetryAsLink={(failure) => {
              setUrl(failure.url);
              setKindOverride(null);
              setLinkName(createName);
              setCreatedFailure(null);
              setTab("link");
            }}
            pending={pending}
            setPending={setPending}
            onClose={onClose}
            onSelect={onSelect}
          />
        </Tabs.Content>
        <Tabs.Content value="link" forceMount hidden={tab !== "link"}>
          <LinkTab
            projectId={projectId}
            url={url}
            onUrl={(next) => {
              setUrl(next);
              setKindOverride(null);
            }}
            name={linkName}
            onName={setLinkName}
            kindOverride={kindOverride}
            onKind={setKindOverride}
            date={date}
            onDate={setDate}
            references={references}
            onReferences={(next) => {
              setReferences(next);
              setReferenceError(undefined);
            }}
            referenceError={referenceError}
            referenceIds={referenceIds}
            removeUnavailable={removeUnavailable}
            pending={pending}
            setPending={setPending}
            onClose={onClose}
            onSelect={onSelect}
          />
        </Tabs.Content>
      </Tabs.Root>
    </Dialog>
  );
}

type SharedProps = {
  projectId: string;
  references: ReferenceChip[];
  onReferences: (next: ReferenceChip[]) => void;
  referenceError: string | undefined;
  referenceIds: string[];
  /** 外した参考資料があれば true(文言と欄の表示は呼び出し元が持つ) */
  removeUnavailable: (error: unknown) => boolean;
  pending: boolean;
  setPending: (pending: boolean) => void;
  onClose: () => void;
  onSelect: Props["onSelect"];
};

/** 案件の表と横パネルを取り直す */
function useReload() {
  const queryClient = useQueryClient();
  return async () => {
    await queryClient.invalidateQueries({ queryKey: ["projects"] });
    await queryClient.invalidateQueries({ queryKey: ["series"] });
  };
}

/** 登録・作成が終わったあとの共通の動き: 一覧を取り直し、その行を選ぶ(design-spec 6.0.1・6.2) */
function useFinish(onClose: () => void, onSelect: Props["onSelect"]) {
  const queryClient = useQueryClient();
  const reload = useReload();
  return async (
    target: { seriesId: string; documentId: string },
    driveStatus?: "active" | "needs_reauth",
  ) => {
    if (driveStatus) applyDriveStatus(queryClient, driveStatus);
    // 選ぶ前に表を取り直す。まだ表に無い系列を選ぶと「見つからない」になる
    await reload();
    onClose();
    onSelect(target);
  };
}

/** 失敗を見て、ダイアログを閉じるべきなら閉じて一覧を読み込み直す(design-spec 6.0.2) */
function useCloseOnFailure(onClose: () => void) {
  const reload = useReload();
  const notify = useNotify();
  const { t } = useTranslation();
  return async (error: unknown): Promise<boolean> => {
    if (!closesDialog(error)) return false;
    onClose();
    await reload();
    const { code, messageKey } = describeError(error);
    if (code !== "PROJECT_NOT_FOUND") {
      notify({ kind: "error", message: t(messageKey), requestId: toApiError(error).requestId });
    }
    return true;
  };
}

function CreateTab({
  projectId,
  kind,
  onKind,
  name,
  onName,
  references,
  onReferences,
  referenceError,
  referenceIds,
  removeUnavailable,
  createdFailure,
  onCreatedFailure,
  onRetryAsLink,
  pending,
  setPending,
  onClose,
  onSelect,
}: SharedProps & {
  kind: CreatableKind;
  onKind: (kind: CreatableKind) => void;
  name: string;
  onName: (name: string) => void;
  createdFailure: CreatedNotRegistered | null;
  onCreatedFailure: (failure: CreatedNotRegistered | null) => void;
  onRetryAsLink: (failure: CreatedNotRegistered) => void;
}) {
  const { t } = useTranslation();
  const { data: me } = useQuery(meQuery);
  const notify = useNotify();
  const finish = useFinish(onClose, onSelect);
  const closeOnFailure = useCloseOnFailure(onClose);
  const reload = useReload();
  const needsReauth = me?.drive.status === "needs_reauth";
  const [touched, setTouched] = useState(false);
  const [serverError, setServerError] = useState<string | undefined>();
  const [alert, setAlert] = useState<string | null>(null);

  const result = validateSingleLine(name, { max: LIMITS.documentName });
  const nameError = touched && !result.ok ? result.error : undefined;
  const message = nameError
    ? t(`errors.fields.${nameError}`, { max: LIMITS.documentName })
    : serverError;

  const create = useMutation({
    mutationFn: (input: { name: string }) =>
      unwrap(
        client.api
          .projects({ projectId })
          .documents.new.post({ kind, name: input.name, referenceIds }),
      ),
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!result.ok || pending || needsReauth) return;
    setPending(true);
    setAlert(null);
    onCreatedFailure(null);
    try {
      const created = await create.mutateAsync({ name: result.value });
      // ブラウザが別タブを止めた場合に備えて、通知にも同じリンクを添える
      window.open(created.editUrl, "_blank", "noopener");
      notify({
        kind: "success",
        message: t("addDocument.created"),
        actions: [{ label: t("addDocument.openEditor"), href: created.editUrl }],
      });
      await finish({ seriesId: created.series.id, documentId: created.document.id });
    } catch (error) {
      if (endsSession(error)) return;
      const failure = createdNotRegistered(error);
      if (failure && failure.cause !== "internal") {
        // 「見つからない」「権限がない」: ダイアログは閉じる。作ったファイルへのリンクは通知に残す
        notify({
          kind: "error",
          message: t("errors.DRIVE_CREATED_NOT_REGISTERED"),
          actions: [{ label: t("addDocument.openCreatedFile"), href: failure.url }],
        });
        onClose();
        await reload();
      } else if (failure) {
        onCreatedFailure(failure);
      } else if (!removeUnavailable(error) && !(await closeOnFailure(error))) {
        const field = fieldErrors(error).name;
        if (field) setServerError(t(`errors.fields.${field}`, { max: LIMITS.documentName }));
        else if (describeError(error).category !== "reauth") {
          setAlert(t(describeError(error).messageKey));
        }
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-[var(--space-stack-gap)]">
      {needsReauth && <ReauthNotice />}
      {createdFailure && (
        <FailureAlert>
          <span>{t("errors.DRIVE_CREATED_NOT_REGISTERED")}</span>
          <a
            href={createdFailure.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-link underline"
          >
            {t("addDocument.openCreatedFile")}
          </a>
          <Button className="self-start" onClick={() => onRetryAsLink(createdFailure)}>
            {t("addDocument.registerByLink")}
          </Button>
        </FailureAlert>
      )}
      {alert && <FailureAlert>{alert}</FailureAlert>}
      <label className="typography-label flex flex-col gap-[var(--space-tight)]">
        {t("addDocument.kind")}
        <select
          value={kind}
          onChange={(event) => onKind(event.target.value as CreatableKind)}
          className={SELECT}
        >
          {CREATABLE.map((value) => (
            <option key={value} value={value}>
              {t(`kinds.${value}`)}
            </option>
          ))}
        </select>
      </label>
      <TextField
        label={t("addDocument.name")}
        value={name}
        error={message}
        onChange={(event) => {
          onName(event.target.value);
          setTouched(true);
          setServerError(undefined);
        }}
      />
      <ReferencePicker
        projectId={projectId}
        value={references}
        onChange={onReferences}
        error={referenceError}
      />
      <p className="typography-caption text-text-muted">{t("addDocument.driveNote")}</p>
      <div className="flex justify-end gap-[var(--space-inline-gap)]">
        <Button disabled={pending} onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button
          type="submit"
          variant="primary"
          loading={pending}
          disabled={!result.ok || needsReauth}
        >
          {t("addDocument.createSubmit")}
        </Button>
      </div>
    </form>
  );
}

type LookupStatus = "none" | "loading" | "ok" | "inaccessible" | "reauth" | "failed";

function LinkTab({
  projectId,
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
  onSelect,
}: SharedProps & {
  url: string;
  onUrl: (url: string) => void;
  name: string;
  onName: (name: string) => void;
  kindOverride: DocumentKind | null;
  onKind: (kind: DocumentKind) => void;
  date: string;
  onDate: (date: string) => void;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const { data: me } = useQuery(meQuery);
  const notify = useNotify();
  const finish = useFinish(onClose, onSelect);
  const closeOnFailure = useCloseOnFailure(onClose);
  const driveActive = me?.drive.status === "active";
  const { pick, picking, element } = useFilePicker();

  const [touched, setTouched] = useState({ url: false, name: false });
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [duplicate, setDuplicate] = useState<ReturnType<typeof duplicateOf>>(null);
  const [alert, setAlert] = useState<string | null>(null);

  const urlResult = validateUrl(url);
  const drive = urlResult.ok ? parseDriveLink(urlResult.value) : null;
  const debouncedUrl = useDebouncedValue(urlResult.ok ? urlResult.value : "");
  const fileId = drive?.googleFileId;
  const settled = urlResult.ok && debouncedUrl === urlResult.value;

  const lookup = useQuery({
    queryKey: ["drive-file", fileId],
    queryFn: () => unwrap(client.api.drive["file-info"].post({ url: debouncedUrl })),
    enabled: Boolean(fileId) && driveActive && settled,
    retry: false,
    gcTime: 0,
  });

  let status: LookupStatus = "none";
  if (drive) {
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

  const kind: DocumentKind =
    info?.kind ?? kindOverride ?? (urlResult.ok ? detectKind(url) : "other");
  const nameValue = info?.name ?? name;
  const nameResult = validateSingleLine(nameValue, { max: LIMITS.documentName });
  const isoDate = info ? info.modifiedAt : dateToIso(date);
  const dateResult = !info && isoDate ? validateSourceModifiedAt(isoDate) : null;

  const urlError = touched.url && !urlResult.ok ? urlResult.error : undefined;
  const nameError = touched.name && !info && !nameResult.ok ? nameResult.error : undefined;

  const register = useMutation({
    mutationFn: (body: {
      url: string;
      name: string;
      kind: DocumentKind;
      sourceModifiedAt: string | null;
      referenceIds: string[];
    }) => unwrap(client.api.projects({ projectId }).documents.post(body)),
  });

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
    (dateResult === null || dateResult.ok) &&
    referenceIds.length <= LIMITS.referencesPerVersion;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched({ url: true, name: true });
    if (!canSubmit || !urlResult.ok || !nameResult.ok || pending) return;
    setPending(true);
    setAlert(null);
    setServerErrors({});
    setDuplicate(null);
    try {
      const created = await register.mutateAsync({
        url: urlResult.value,
        name: nameResult.value,
        kind,
        sourceModifiedAt: isoDate,
        referenceIds,
      });
      notify({ kind: "success", message: t("addDocument.added") });
      await finish(
        { seriesId: created.series.id, documentId: created.document.id },
        created.driveStatus,
      );
    } catch (error) {
      if (endsSession(error)) return;
      const existing = duplicateOf(error);
      if (existing) {
        setDuplicate(existing);
      } else if (!removeUnavailable(error) && !(await closeOnFailure(error))) {
        const fields = fieldErrors(error);
        const next: Record<string, string> = {};
        for (const [field, code] of Object.entries(fields)) {
          next[field] = t(`errors.fields.${code}`, { max: LIMITS.documentName });
        }
        if (next.url || next.name || next.sourceModifiedAt) setServerErrors(next);
        else if (describeError(error).category !== "reauth") {
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
    <form onSubmit={submit} className="flex flex-col gap-[var(--space-stack-gap)]">
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
              onSelect({ seriesId: duplicate.seriesId, documentId: duplicate.documentId });
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
          readOnly={info !== undefined}
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
        {info && (
          <p className="typography-caption text-text-muted">{t("addDocument.useDriveName")}</p>
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
            disabled={info !== undefined}
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
        {info ? (
          <div className="typography-label flex flex-col gap-[var(--space-tight)]">
            {t("addDocument.modifiedAt")}
            <span className="typography-body flex h-[var(--size-control)] items-center">
              {formatDate(info.modifiedAt, locale)}
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

      <ReferencePicker
        projectId={projectId}
        value={references}
        onChange={onReferences}
        error={referenceError}
      />
      <div className="flex justify-end gap-[var(--space-inline-gap)]">
        <Button disabled={pending} onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" variant="primary" loading={pending} disabled={!canSubmit}>
          {t("addDocument.addSubmit")}
        </Button>
      </div>
      {element}
    </form>
  );
}
