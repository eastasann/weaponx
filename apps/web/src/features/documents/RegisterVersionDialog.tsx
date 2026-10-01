import { useMutation, useQuery } from "@tanstack/react-query";
import { type DocumentKind, LIMITS, validateSingleLine } from "@weaponx/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "../../components/Dialog";
import { LoadError } from "../../components/LoadError";
import { TextField } from "../../components/TextField";
import { useNotify } from "../../components/Toast";
import { client, unwrap } from "../../lib/api";
import { describeError } from "../../lib/errors";
import { type RelatedItem, seriesDetailQuery } from "../../lib/queries";
import { chipsFromRelated, useFinish, useReferences } from "./dialog-support";
import { type LinkBody, LinkForm } from "./LinkForm";

/** 「このリンクで登録」から開くときの、入力済みの内容(design-spec 6.0.8) */
export type RegisterVersionPrefill = { url: string; name: string; changeNote: string };

type Props = {
  projectId: string;
  seriesId: string;
  prefill?: RegisterVersionPrefill;
  onClose: () => void;
  /** 登録できた(または重複した資料を選ぶ)とき、その系列と版を選ぶ */
  onSelect: (target: { seriesId: string; documentId: string }) => void;
};

/**
 * 新しい版を登録ダイアログ(design-spec 6.5.5)。系列の最新版の名前と参考資料を初期値にして、
 * 次の版としてリンクで登録する
 */
export function RegisterVersionDialog({ projectId, seriesId, prefill, onClose, onSelect }: Props) {
  const { t } = useTranslation();
  // 最新版を開く。操作の欄を出した時点の最新版ではなく、開いた時点の最新版を初期値にする
  const latest = useQuery({ ...seriesDetailQuery(seriesId, undefined), staleTime: 0 });
  const detail = latest.isPlaceholderData ? undefined : latest.data;
  const version = detail?.versions.find((candidate) => candidate.id === detail.selectedDocumentId);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={t("registerVersion.title")}>
      {latest.isError ? (
        <LoadError
          message={t(describeError(latest.error, "read").messageKey)}
          onReload={() => void latest.refetch()}
        />
      ) : !detail || !version ? (
        <p role="status" className="typography-body text-text-muted">
          {t("common.loading")}
        </p>
      ) : (
        <RegisterVersionForm
          projectId={projectId}
          seriesId={seriesId}
          initialName={version.name}
          initialReferences={detail.references}
          {...(prefill ? { prefill } : {})}
          onClose={onClose}
          onSelect={onSelect}
        />
      )}
    </Dialog>
  );
}

function RegisterVersionForm({
  projectId,
  seriesId,
  initialName,
  initialReferences,
  prefill,
  onClose,
  onSelect,
}: Pick<Props, "projectId" | "seriesId" | "prefill" | "onClose" | "onSelect"> & {
  initialName: string;
  initialReferences: RelatedItem[];
}) {
  const { t } = useTranslation();
  const notify = useNotify();
  const finish = useFinish(onClose);
  const refs = useReferences(chipsFromRelated(initialReferences));
  const [url, setUrl] = useState(prefill?.url ?? "");
  const [name, setName] = useState(prefill?.name ?? initialName);
  const [kindOverride, setKindOverride] = useState<DocumentKind | null>(null);
  const [date, setDate] = useState("");
  const [changeNote, setChangeNote] = useState(prefill?.changeNote ?? "");
  const [noteServerError, setNoteServerError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);

  const noteResult = validateSingleLine(changeNote, { max: LIMITS.changeNote, required: false });

  const register = useMutation({
    mutationFn: (input: LinkBody & { changeNote: string }) =>
      unwrap(
        client.api.series({ seriesId }).versions.post({
          ...input,
          hiddenReferenceIds: refs.hiddenReferenceIds,
        }),
      ),
  });

  return (
    <LinkForm
      projectId={projectId}
      excludeSeriesId={seriesId}
      url={url}
      onUrl={(next) => {
        setUrl(next);
        setKindOverride(null);
      }}
      name={name}
      onName={setName}
      kindOverride={kindOverride}
      onKind={setKindOverride}
      date={date}
      onDate={setDate}
      {...refs}
      pending={pending}
      setPending={setPending}
      onClose={onClose}
      onSelectExisting={onSelect}
      submitLabel={t("registerVersion.submit")}
      extraValid={noteResult.ok}
      extraFields={
        <TextField
          label={t("copyDialog.changeNote")}
          value={changeNote}
          placeholder={t("copyDialog.changeNotePlaceholder")}
          error={
            noteResult.ok
              ? noteServerError
              : t(`errors.fields.${noteResult.error}`, { max: LIMITS.changeNote })
          }
          onChange={(event) => {
            setChangeNote(event.target.value);
            setNoteServerError(undefined);
          }}
        />
      }
      onFieldErrors={(fields) => {
        if (fields.changeNote) {
          setNoteServerError(t(`errors.fields.${fields.changeNote}`, { max: LIMITS.changeNote }));
        }
        if (fields.referenceIds) {
          refs.setReferenceError(t("references.limit", { max: LIMITS.referencesPerVersion }));
        }
        return Boolean(fields.changeNote || fields.referenceIds);
      }}
      submit={async (body) => {
        // 登録の操作は `extraValid` が真のときだけ届く。ここは型の絞り込み
        if (!noteResult.ok) throw new Error("入力が検証を通っていません");
        const created = await register.mutateAsync({ ...body, changeNote: noteResult.value });
        notify({ kind: "success", message: t("registerVersion.registered") });
        await finish(created.driveStatus);
        onSelect({ seriesId: created.series.id, documentId: created.document.id });
      }}
    />
  );
}
