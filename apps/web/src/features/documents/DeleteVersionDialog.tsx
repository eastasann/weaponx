import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../../components/Dialog";
import { useNotify, useNotifyError } from "../../components/Toast";
import { client, unwrap } from "../../lib/api";
import { describeError } from "../../lib/errors";
import { closesDialog, endsSession } from "./failure";

type Props = {
  version: { id: string; name: string; versionNo: number };
  onClose: () => void;
  /** 削除できた。系列が残っていれば、その最新版の ID を渡す */
  onDeleted: (result: { seriesRemoved: boolean; latestId: string | null }) => void;
};

/** 版の削除の確認(design-spec 6.1)。元の場所にあるファイルは消えない */
export function DeleteVersionDialog({ version, onClose, onDeleted }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const notify = useNotify();
  const notifyError = useNotifyError();

  const remove = useMutation({
    mutationFn: () => unwrap(client.api.documents({ documentId: version.id }).delete()),
    onSuccess: (result) => {
      onClose();
      onDeleted({
        seriesRemoved: result.seriesRemoved,
        latestId: result.series?.latest.id ?? null,
      });
    },
    onError: async (error) => {
      if (closesDialog(error)) {
        onClose();
        await queryClient.invalidateQueries({ queryKey: ["projects"] });
        await queryClient.invalidateQueries({ queryKey: ["series"] });
        if (describeError(error).code !== "PROJECT_NOT_FOUND") {
          notify({ kind: "error", message: t(describeError(error).messageKey) });
        }
      } else if (!endsSession(error)) {
        notifyError(error);
      }
    },
  });

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("deleteVersion.title")}
      message={t("deleteVersion.message", { name: version.name, n: version.versionNo })}
      confirmLabel={t("project.deleteConfirm")}
      destructive
      pending={remove.isPending}
      onConfirm={() => remove.mutate()}
    />
  );
}
