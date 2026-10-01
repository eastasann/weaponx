import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type DocumentKind, LIMITS, validateSingleLine } from "@weaponx/shared";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { KindIcon } from "../../components/KindIcon";
import { TextField } from "../../components/TextField";
import { useNotify } from "../../components/Toast";
import { client, unwrap } from "../../lib/api";
import { describeError, fieldErrors, toApiError } from "../../lib/errors";
import { meQuery, projectsQuery } from "../../lib/queries";
import {
  type CreatedNotRegistered,
  closesDialog,
  createdNotRegistered,
  endsSession,
} from "./failure";
import { DriveGuidance, FailureAlert, ReauthNotice } from "./notices";

export type CopySource = {
  documentId: string;
  name: string;
  kind: DocumentKind;
  versionNo: number;
};

type Props = {
  /** `copy`: これを元に作る(別の案件にも作れる)。`newVersion`: 同じ系列の次の版を作る */
  mode: "copy" | "newVersion";
  projectId: string;
  projectName: string;
  seriesId: string;
  source: CopySource;
  onClose: () => void;
  /** 作成して登録できた。表を取り直した後に呼ぶ(行を選ぶ・案件へのリンクを出すのは呼び出し側) */
  onCreated: (result: {
    projectId: string;
    projectName: string;
    seriesId: string;
    documentId: string;
    editUrl: string;
  }) => void;
  /** 「このリンクで登録」(新しい版を作る、または追加先が今の案件のこれを元に作る。design-spec 6.0.8) */
  onRegisterByLink: (failure: CreatedNotRegistered, name: string, changeNote: string) => void;
};

/** 作成ダイアログ(design-spec 6.3)。元の資料をドライブ上でコピーして、新しいファイルを作る */
export function CopyDialog({
  mode,
  projectId,
  projectName,
  seriesId,
  source,
  onClose,
  onCreated,
  onRegisterByLink,
}: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const notify = useNotify();
  const { data: me } = useQuery(meQuery);
  const projects = useQuery(projectsQuery);
  const needsReauth = me?.drive.status === "needs_reauth";

  const [name, setName] = useState(
    mode === "copy" ? t("copyDialog.defaultName", { name: source.name }) : source.name,
  );
  const [changeNote, setChangeNote] = useState("");
  const [targetId, setTargetId] = useState(projectId);
  const [touched, setTouched] = useState(false);
  const [nameServerError, setNameServerError] = useState<string | undefined>();
  const [targetError, setTargetError] = useState(false);
  const [alert, setAlert] = useState<string | null>(null);
  const [createdFailure, setCreatedFailure] = useState<CreatedNotRegistered | null>(null);
  const [pending, setPending] = useState(false);

  // ダイアログを開いた時点で、コピー元をアプリが使えるかを確かめる(design-spec 6.3)
  const access = useQuery({
    queryKey: ["drive-access", source.documentId],
    queryFn: () =>
      unwrap(client.api.documents({ documentId: source.documentId })["drive-access"].get()),
    enabled: !needsReauth,
    retry: false,
    gcTime: 0,
  });

  const nameResult = validateSingleLine(name, { max: LIMITS.documentName });
  const noteResult = validateSingleLine(changeNote, { max: LIMITS.changeNote, required: false });
  const nameError = touched && !nameResult.ok ? nameResult.error : undefined;
  const checking = !needsReauth && access.isPending;
  const unusable = access.data?.accessible === false;
  const accessFailure = access.isError && toApiError(access.error).code !== "DRIVE_REAUTH_REQUIRED";
  const canSubmit =
    nameResult.ok && noteResult.ok && !needsReauth && !checking && !unusable && !accessFailure;

  const targets = (projects.data?.projects ?? []).filter(
    (project) => project.myRole !== "viewer" || project.id === projectId,
  );
  // 追加先に追加できなくなって候補から外れたら、今の案件に戻す(選択欄の表示と送る値を一致させる)
  const target = targets.some((project) => project.id === targetId) ? targetId : projectId;

  const create = useMutation({
    mutationFn: async (input: { name: string; changeNote: string }) => {
      if (mode === "copy") {
        return unwrap(
          client.api
            .documents({ documentId: source.documentId })
            .copies.post({ targetProjectId: target, name: input.name }),
        );
      }
      const created = await unwrap(
        client.api.series({ seriesId }).versions.copy.post({
          sourceDocumentId: source.documentId,
          name: input.name,
          ...(input.changeNote ? { changeNote: input.changeNote } : {}),
        }),
      );
      return { projectId, ...created };
    },
  });

  const reload = async () => {
    await queryClient.invalidateQueries({ queryKey: ["projects"] });
    await queryClient.invalidateQueries({ queryKey: ["series"] });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!canSubmit || !nameResult.ok || !noteResult.ok || pending) return;
    setPending(true);
    setAlert(null);
    setTargetError(false);
    setCreatedFailure(null);
    try {
      const created = await create.mutateAsync({
        name: nameResult.value,
        changeNote: noteResult.value,
      });
      // ブラウザが別タブを止めた場合に備えて、通知にも同じリンクを添える(呼び出し側が通知する)
      window.open(created.editUrl, "_blank", "noopener");
      await reload();
      onClose();
      onCreated({
        projectId: created.projectId,
        projectName:
          targets.find((project) => project.id === created.projectId)?.name ?? projectName,
        seriesId: created.series.id,
        documentId: created.document.id,
        editUrl: created.editUrl,
      });
    } catch (error) {
      await handleFailure(error);
    } finally {
      setPending(false);
    }
  };

  async function handleFailure(error: unknown) {
    if (endsSession(error)) return;
    const { code, messageKey, category } = describeError(error);
    const failure = createdNotRegistered(error);
    if (failure) {
      if (failure.cause === "internal") {
        setCreatedFailure(failure);
        return;
      }
      // 確認の後、登録までの間に状態が変わった: ダイアログを閉じ、作ったファイルへのリンクを通知に残す
      notify({
        kind: "error",
        message: t("errors.DRIVE_CREATED_NOT_REGISTERED"),
        actions: [{ label: t("addDocument.openCreatedFile"), href: failure.url }],
      });
      onClose();
      await reload();
      return;
    }
    if (code === "TARGET_PROJECT_UNAVAILABLE") {
      // 今の案件を「見つからない」にはしない。追加先の候補を読み直す(design-spec 6.0.8)
      setTargetError(true);
      await queryClient.invalidateQueries({ queryKey: ["projects"], exact: true });
      return;
    }
    if (closesDialog(error)) {
      onClose();
      await reload();
      if (code !== "PROJECT_NOT_FOUND") {
        notify({ kind: "error", message: t(messageKey), requestId: toApiError(error).requestId });
      }
      return;
    }
    const field = fieldErrors(error).name;
    if (field) {
      setNameServerError(t(`errors.fields.${field}`, { max: LIMITS.documentName }));
    } else if (category !== "reauth") {
      setAlert(t(messageKey));
    }
  }

  const dialogTitle = mode === "copy" ? t("copyDialog.copyTitle") : t("copyDialog.newVersionTitle");
  const nameMessage = nameError
    ? t(`errors.fields.${nameError}`, { max: LIMITS.documentName })
    : nameServerError;

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()} title={dialogTitle}>
      <form onSubmit={submit} className="flex flex-col gap-[var(--space-stack-gap)]">
        {needsReauth && <ReauthNotice />}
        {unusable && access.data && (
          <DriveGuidance fileId={access.data.fileId} onGranted={() => void access.refetch()} />
        )}
        {accessFailure && (
          <FailureAlert>
            <span>{t(describeError(access.error, "read").messageKey)}</span>
            <Button className="self-start" onClick={() => void access.refetch()}>
              {t("errors.reload")}
            </Button>
          </FailureAlert>
        )}
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
            {(mode === "newVersion" || target === projectId) && (
              <Button
                className="self-start"
                onClick={() =>
                  onRegisterByLink(
                    createdFailure,
                    nameResult.ok ? nameResult.value : name,
                    noteResult.ok ? noteResult.value : changeNote,
                  )
                }
              >
                {t("addDocument.registerByLink")}
              </Button>
            )}
          </FailureAlert>
        )}
        {alert && <FailureAlert>{alert}</FailureAlert>}
        <p className="typography-body flex flex-wrap items-center gap-[var(--space-inline-gap)]">
          <span className="typography-label">{t("copyDialog.source")}</span>
          <KindIcon kind={source.kind} />
          <span className="min-w-0 break-words">
            {t("copyDialog.sourceName", {
              name: source.name,
              n: source.versionNo,
              project: projectName,
            })}
          </span>
        </p>
        <TextField
          label={t("addDocument.name")}
          value={name}
          error={nameMessage}
          onChange={(event) => {
            setName(event.target.value);
            setTouched(true);
            setNameServerError(undefined);
          }}
        />
        {mode === "copy" ? (
          <div className="flex flex-col gap-[var(--space-tight)]">
            <label className="typography-label flex flex-col gap-[var(--space-tight)]">
              {t("copyDialog.target")}
              <select
                value={target}
                aria-invalid={targetError ? true : undefined}
                onChange={(event) => {
                  setTargetId(event.target.value);
                  setTargetError(false);
                }}
                className="typography-body h-[var(--size-control)] rounded-[var(--radius-control)] border border-border-strong bg-surface px-[var(--space-inline-gap)] text-text"
              >
                {targets.length === 0 && <option value={projectId}>{projectName}</option>}
                {targets.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
            {targetError && (
              <p role="alert" className="typography-caption text-danger">
                {t("errors.TARGET_PROJECT_UNAVAILABLE")}
              </p>
            )}
          </div>
        ) : (
          <TextField
            label={t("copyDialog.changeNote")}
            value={changeNote}
            placeholder={t("copyDialog.changeNotePlaceholder")}
            error={
              noteResult.ok
                ? undefined
                : t(`errors.fields.${noteResult.error}`, { max: LIMITS.changeNote })
            }
            onChange={(event) => setChangeNote(event.target.value)}
          />
        )}
        <p className="typography-caption text-text-muted">{t("addDocument.driveNote")}</p>
        <div className="flex justify-end gap-[var(--space-inline-gap)]">
          <Button disabled={pending} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={pending || checking}
            disabled={!canSubmit}
          >
            {t("addDocument.createSubmit")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
