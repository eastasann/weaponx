import { useTranslation } from "react-i18next";
import { Button } from "./Button";

/** 読み込みの失敗と「再読み込み」(design-spec 6.0.2) */
export function LoadError({ message, onReload }: { message?: string; onReload: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-[var(--space-stack-gap)] p-[var(--space-section-gap)] text-center"
    >
      <p className="typography-body text-text-muted">{message ?? t("errors.loadFailed")}</p>
      <Button onClick={onReload}>{t("errors.reload")}</Button>
    </div>
  );
}
