import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

/** モバイルで URL を直接開いたときの、メンバー管理・利用者管理の代わりの表示(design-spec 6.6) */
export function DesktopOnly() {
  const { t } = useTranslation();
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-[var(--space-stack-gap)] p-[var(--space-page-gutter)] text-center">
      <p className="typography-section-heading">{t("members.desktopOnly")}</p>
      <Link
        to="/"
        className="typography-label inline-flex h-[var(--size-control)] items-center rounded-[var(--radius-control)] bg-accent px-[var(--space-stack-gap)] text-on-accent hover:bg-accent-hover"
      >
        {t("errorPage.toHome")}
      </Link>
    </main>
  );
}
