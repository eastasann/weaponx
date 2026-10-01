import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/Button";
import { useNotifyError } from "../../components/Toast";
import { currentPath, reconnectUrl } from "../../lib/reconnect";
import { endsSession } from "./failure";
import { useFilePicker } from "./file-picker";

const BOX =
  "typography-body flex flex-col gap-[var(--space-inline-gap)] rounded-[var(--radius-control)] border p-[var(--space-inline-gap)]";

/** ダイアログの上部に出す、ドライブ連携の有効期限切れの案内(design-spec 6.0.5) */
export function ReauthNotice({ message }: { message?: string }) {
  const { t } = useTranslation();
  return (
    <div role="alert" className={`${BOX} border-warning-border bg-warning-surface text-warning`}>
      <span>{message ?? t("reauth.banner")}</span>
      <Button
        className="self-start"
        onClick={() => window.location.assign(reconnectUrl(currentPath()))}
      >
        {t("reauth.action")}
      </Button>
    </div>
  );
}

/** ダイアログの上部に出す失敗の知らせ(design-spec 6.0.2 の「ダイアログは閉じず、入力を保つ」) */
export function FailureAlert({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className={`${BOX} border-danger bg-danger-surface text-danger`}>
      {children}
    </div>
  );
}

/**
 * アプリがまだ使えないファイルの案内と「このファイルをアプリで使えるようにする」(design-spec 6.0.9)。
 * 選び終えたら `onGranted` を呼ぶ(呼び出し側が元の操作をやり直す)。選ばずに閉じたら何もしない
 */
export function DriveGuidance({ fileId, onGranted }: { fileId: string; onGranted: () => void }) {
  const { t } = useTranslation();
  const notifyError = useNotifyError();
  const { pick, picking, element } = useFilePicker();

  const choose = async () => {
    try {
      const picked = await pick(fileId);
      if (picked) onGranted();
    } catch (error) {
      if (!endsSession(error)) notifyError(error);
    }
  };

  return (
    <div className="typography-caption flex flex-col items-start gap-[var(--space-tight)] text-text-muted">
      <p>{t("guidance.text")}</p>
      <p>{t("guidance.noPermission")}</p>
      <Button loading={picking} onClick={() => void choose()}>
        {t("guidance.action")}
      </Button>
      {element}
    </div>
  );
}
