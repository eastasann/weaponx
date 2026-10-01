import { useMutation, useQuery } from "@tanstack/react-query";
import { type DocumentKind, LIMITS, validateSingleLine } from "@weaponx/shared";
import { Tabs } from "radix-ui";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { TextField } from "../../components/TextField";
import { useNotify } from "../../components/Toast";
import { client, unwrap } from "../../lib/api";
import { describeError, fieldErrors } from "../../lib/errors";
import { meQuery } from "../../lib/queries";
import { SELECT, useCloseOnFailure, useFinish, useReferences, useReload } from "./dialog-support";
import { type CreatedNotRegistered, createdNotRegistered, endsSession } from "./failure";
import { type LinkBody, LinkForm } from "./LinkForm";
import { FailureAlert, ReauthNotice } from "./notices";
import { type ReferenceChip, ReferencePicker } from "./ReferencePicker";

type CreatableKind = "google_doc" | "google_slides";
const CREATABLE: CreatableKind[] = ["google_doc", "google_slides"];

export type AddDocumentPrefill = { url: string; name: string; references: ReferenceChip[] };

type Props = {
  projectId: string;
  /** 「このリンクで登録」から開くときの、入力済みの内容(design-spec 6.0.8) */
  prefill?: AddDocumentPrefill;
  onClose: () => void;
  /** 登録できた(または重複した資料を選ぶ)とき、その系列と版を選ぶ */
  onSelect: (target: { seriesId: string; documentId: string }) => void;
};

/** 資料を追加ダイアログ(design-spec 6.2)。「新しく作る」(既定)と「リンクで登録」 */
export function AddDocumentDialog({ projectId, prefill, onClose, onSelect }: Props) {
  const { t } = useTranslation();
  const { data: me } = useQuery(meQuery);
  const needsReauth = me?.drive.status === "needs_reauth";
  const [tab, setTab] = useState<"create" | "link">(prefill || needsReauth ? "link" : "create");
  const refs = useReferences(prefill?.references ?? []);
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
            {...refs}
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
          <AddLinkTab
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
            {...refs}
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

/** 登録・作成が終わったあとの共通の動き: 一覧を取り直し、その行を選ぶ(design-spec 6.0.1・6.2) */
function useSelectAfter(onClose: () => void, onSelect: Props["onSelect"]) {
  const finish = useFinish(onClose);
  return async (
    target: { seriesId: string; documentId: string },
    driveStatus?: "active" | "needs_reauth",
  ) => {
    await finish(driveStatus);
    onSelect(target);
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
  const finish = useSelectAfter(onClose, onSelect);
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

/** 「リンクで登録」のタブ。入力欄は `LinkForm` が持ち、送信と成功のあとの動きだけをここで決める */
function AddLinkTab({
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
  const notify = useNotify();
  const finish = useSelectAfter(onClose, onSelect);

  const register = useMutation({
    mutationFn: (body: LinkBody) => unwrap(client.api.projects({ projectId }).documents.post(body)),
  });

  return (
    <LinkForm
      projectId={projectId}
      url={url}
      onUrl={onUrl}
      name={name}
      onName={onName}
      kindOverride={kindOverride}
      onKind={onKind}
      date={date}
      onDate={onDate}
      references={references}
      onReferences={onReferences}
      referenceError={referenceError}
      referenceIds={referenceIds}
      removeUnavailable={removeUnavailable}
      pending={pending}
      setPending={setPending}
      onClose={onClose}
      onSelectExisting={onSelect}
      submitLabel={t("addDocument.addSubmit")}
      submit={async (body) => {
        const created = await register.mutateAsync(body);
        notify({ kind: "success", message: t("addDocument.added") });
        await finish(
          { seriesId: created.series.id, documentId: created.document.id },
          created.driveStatus,
        );
      }}
    />
  );
}
