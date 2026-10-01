import { useMutation, useQuery } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { KindIcon } from "../../components/KindIcon";
import { LoadError } from "../../components/LoadError";
import { client, unwrap } from "../../lib/api";
import { describeError } from "../../lib/errors";
import { openGooglePicker } from "../../lib/google-picker";
import { configQuery } from "../../lib/queries";
import { endsSession } from "./failure";

type FilePicker = {
  /**
   * ファイル選択画面を開き、選んだファイルの ID を返す(選ばずに閉じたら null)。
   * 選んだファイルはアプリで使えるようになっている(design-spec 6.0.9)。失敗は `ApiError` を投げる
   */
  pick: (fileId?: string) => Promise<string | null>;
  /** 選択画面を開いている間 true */
  picking: boolean;
  /** 模擬のファイル選択画面。呼び出し側のダイアログの中に置く */
  element: ReactNode;
};

/**
 * ファイル選択画面(design-spec 6.0.9)。`/api/config` の `picker` があれば Google Picker、
 * 無ければ(`DRIVE_MODE=mock`)模擬の画面を出す(02-01 5.10)。
 */
export function useFilePicker(): FilePicker {
  const { data: config } = useQuery(configQuery);
  const [picking, setPicking] = useState(false);
  const [mock, setMock] = useState<{ fileId: string | undefined } | null>(null);
  const settle = useRef<((fileId: string | null) => void) | null>(null);
  // 失敗を全体の処理(要再連携・セッション切れ)に渡すため、ミューテーションで呼ぶ
  const issueToken = useMutation({
    mutationFn: () => unwrap(client.api.drive["picker-token"].post()),
  });
  const { mutateAsync: requestToken } = issueToken;

  const pick = useCallback(
    async (fileId?: string) => {
      if (!config || settle.current) return null;
      setPicking(true);
      try {
        if (config.picker) {
          const token = await requestToken();
          return await openGooglePicker({
            apiKey: config.picker.apiKey,
            appId: config.picker.appId,
            accessToken: token.accessToken,
            fileId,
          });
        }
        return await new Promise<string | null>((resolve) => {
          settle.current = resolve;
          setMock({ fileId });
        });
      } finally {
        setPicking(false);
      }
    },
    [config, requestToken],
  );

  const close = useCallback((fileId: string | null) => {
    settle.current?.(fileId);
    settle.current = null;
    setMock(null);
  }, []);

  // 画面を離れるときに、待っている呼び出しを終わらせる
  useEffect(() => () => settle.current?.(null), []);

  const element = mock ? <MockPickerDialog fileId={mock.fileId} onClose={close} /> : null;
  return { pick, picking, element };
}

/** 模擬のファイル選択画面(シードのドライブの資料の一覧)。選ぶと API に使えるファイルとして記録する */
function MockPickerDialog({
  fileId,
  onClose,
}: {
  fileId: string | undefined;
  onClose: (fileId: string | null) => void;
}) {
  const { t } = useTranslation();
  const files = useQuery({
    queryKey: ["dev", "drive", "files"],
    queryFn: () => unwrap(client.api.dev.drive.files.get()),
    gcTime: 0,
  });
  const [choosing, setChoosing] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const grant = useMutation({
    mutationFn: (id: string) => unwrap(client.api.dev.drive.grant.post({ fileId: id })),
  });

  const choose = async (id: string) => {
    setChoosing(id);
    setFailure(null);
    try {
      await grant.mutateAsync(id);
      onClose(id);
    } catch (error) {
      setChoosing(null);
      setFailure(error);
    }
  };

  const shown = (files.data?.files ?? []).filter((file) => !fileId || file.fileId === fileId);

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !choosing && onClose(null)}
      title={t("filePicker.title")}
      description={t("filePicker.mockHint")}
      footer={
        <Button disabled={choosing !== null} onClick={() => onClose(null)}>
          {t("common.cancel")}
        </Button>
      }
    >
      {files.isError ? (
        <LoadError onReload={() => void files.refetch()} />
      ) : files.isPending ? (
        <p className="typography-body text-text-muted">{t("common.loading")}</p>
      ) : shown.length === 0 ? (
        <p className="typography-body text-text-muted">{t("filePicker.empty")}</p>
      ) : (
        <ul className="flex max-h-72 flex-col gap-[var(--space-tight)] overflow-y-auto">
          {shown.map((file) => (
            <li key={file.fileId}>
              <button
                type="button"
                disabled={choosing !== null}
                onClick={() => void choose(file.fileId)}
                className="typography-body flex w-full items-center gap-[var(--space-inline-gap)] rounded-[var(--radius-control)] px-[var(--space-inline-gap)] py-[var(--space-tight)] text-left hover:bg-row-hover disabled:opacity-50"
              >
                <KindIcon kind={file.kind} />
                <span className="min-w-0 break-words">{file.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {failure !== null && !endsSession(failure) && (
        <p role="alert" className="typography-caption text-danger">
          {t(describeError(failure).messageKey)}
        </p>
      )}
    </Dialog>
  );
}
