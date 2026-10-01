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
import { type RelatedItem, type SeriesDetail, seriesDetailQuery } from "../../lib/queries";
import { chipsFromRelated, isoToDate, useFinish, useReferences } from "./dialog-support";
import { type LinkBody, LinkForm } from "./LinkForm";
import { finalTags, TagInput } from "./TagInput";

type Version = SeriesDetail["versions"][number];

type Props = {
  projectId: string;
  seriesId: string;
  /** 編集する版 */
  documentId: string;
  onClose: () => void;
  /** 重複した資料を選ぶ */
  onSelect: (target: { seriesId: string; documentId: string }) => void;
};

/** 登録内容を編集ダイアログ(design-spec 6.5.6)。選んでいる版のリンク・資料名・変更メモ・タグ・参考資料を直す */
export function EditDocumentDialog({ projectId, seriesId, documentId, onClose, onSelect }: Props) {
  const { t } = useTranslation();
  // 開いた時点の保存済みの内容を初期値にする
  const detail = useQuery({ ...seriesDetailQuery(seriesId, documentId), staleTime: 0 });
  const data = detail.isPlaceholderData ? undefined : detail.data;
  const version = data?.versions.find((candidate) => candidate.id === documentId);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={t("editDocument.title")}>
      {detail.isError ? (
        <LoadError
          message={t(describeError(detail.error, "read").messageKey)}
          onReload={() => void detail.refetch()}
        />
      ) : !data || !version ? (
        <p role="status" className="typography-body text-text-muted">
          {t("common.loading")}
        </p>
      ) : (
        <EditForm
          projectId={projectId}
          seriesId={seriesId}
          version={version}
          references={data.references}
          onClose={onClose}
          onSelect={onSelect}
        />
      )}
    </Dialog>
  );
}

function EditForm({
  projectId,
  seriesId,
  version,
  references: initialReferences,
  onClose,
  onSelect,
}: Pick<Props, "projectId" | "seriesId" | "onClose" | "onSelect"> & {
  version: Version;
  references: RelatedItem[];
}) {
  const { t } = useTranslation();
  const notify = useNotify();
  const finish = useFinish(onClose);
  const refs = useReferences(chipsFromRelated(initialReferences));
  const [url, setUrl] = useState(version.url);
  const [name, setName] = useState(version.name);
  const [kindOverride, setKindOverride] = useState<DocumentKind | null>(version.kind);
  const [date, setDate] = useState(isoToDate(version.sourceModifiedAt));
  const [changeNote, setChangeNote] = useState(version.changeNote ?? "");
  const [noteServerError, setNoteServerError] = useState<string | undefined>();
  const [tags, setTags] = useState(version.tags);
  const [tagInput, setTagInput] = useState("");
  const [tagServerError, setTagServerError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);

  const noteResult = validateSingleLine(changeNote, { max: LIMITS.changeNote, required: false });
  const tagsResult = finalTags(tags, tagInput);

  const save = useMutation({
    mutationFn: (body: Parameters<ReturnType<typeof client.api.documents>["patch"]>[0]) =>
      unwrap(client.api.documents({ documentId: version.id }).patch(body)),
  });

  return (
    <LinkForm
      projectId={projectId}
      excludeSeriesId={seriesId}
      saved={{
        url: version.url,
        name: version.name,
        kind: version.kind,
        sourceModifiedAt: version.sourceModifiedAt,
        nameLocked: version.nameLocked,
      }}
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
      submitLabel={t("editDocument.submit")}
      extraValid={noteResult.ok && tagsResult.ok}
      extraFields={
        <>
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
          <TagInput
            projectId={projectId}
            value={tags}
            onChange={(next) => {
              setTags(next);
              setTagServerError(undefined);
            }}
            input={tagInput}
            onInput={(next) => {
              setTagInput(next);
              setTagServerError(undefined);
            }}
            error={
              tagServerError ??
              (!tagsResult.ok && tags.length >= LIMITS.tagsPerVersion
                ? t("tags.limit", { max: LIMITS.tagsPerVersion })
                : undefined)
            }
          />
        </>
      }
      onFieldErrors={(fields) => {
        if (fields.changeNote) {
          setNoteServerError(t(`errors.fields.${fields.changeNote}`, { max: LIMITS.changeNote }));
        }
        if (fields.tags) {
          setTagServerError(
            fields.tags === "too_many"
              ? t("tags.limit", { max: LIMITS.tagsPerVersion })
              : t(`errors.fields.${fields.tags}`, { max: LIMITS.tag }),
          );
        }
        if (fields.referenceIds) {
          refs.setReferenceError(t("references.limit", { max: LIMITS.referencesPerVersion }));
        }
        return Boolean(fields.changeNote || fields.tags || fields.referenceIds);
      }}
      submit={async (body: LinkBody, { locked }) => {
        // 保存の操作は `extraValid` が真のときだけ届く。ここは型の絞り込み
        if (!tagsResult.ok || !noteResult.ok) throw new Error("入力が検証を通っていません");
        // 日付を変えていなければ、保存済みの日時をそのまま送る(日付ピッカーは時刻を持たない)
        const unchangedDate = date === isoToDate(version.sourceModifiedAt);
        const result = await save.mutateAsync({
          ...(body.url !== version.url ? { url: body.url } : {}),
          ...(locked
            ? {}
            : {
                kind: body.kind,
                name: body.name,
                sourceModifiedAt: unchangedDate ? version.sourceModifiedAt : body.sourceModifiedAt,
              }),
          changeNote: noteResult.value,
          tags: tagsResult.value.map((tag) => tag.label),
          referenceIds: body.referenceIds,
          hiddenReferenceIds: refs.hiddenReferenceIds,
        });
        notify({ kind: "success", message: t("editDocument.saved") });
        await finish(result.driveStatus);
      }}
    />
  );
}
