import { useTranslation } from "react-i18next";
import { Button } from "../../components/Button";
import { currentPath, reconnectUrl } from "../../lib/reconnect";

/**
 * 要再連携の帯(design-spec 3.5・6.0.5)。モバイルでは出さない。
 * 「もう一度連携する」で Google の許可画面へ移り、終わると今の画面へ戻る。
 */
export function ReauthBanner() {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className="typography-body flex items-center justify-center gap-[var(--space-stack-gap)] border-b border-warning-border bg-warning-surface px-[var(--space-page-gutter)] py-[var(--space-inline-gap)] text-warning max-md:hidden"
    >
      <span>{t("reauth.banner")}</span>
      <Button
        variant="secondary"
        onClick={() => window.location.assign(reconnectUrl(currentPath()))}
      >
        {t("reauth.action")}
      </Button>
    </div>
  );
}
