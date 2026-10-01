import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

/** 案件が無い・参加していない・削除済みのときの全画面表示。理由は区別しない(design-spec 6.1) */
export function ProjectNotFound() {
  const { t } = useTranslation();
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-[var(--space-stack-gap)] p-[var(--space-page-gutter)] text-center">
      <p role="alert" className="typography-section-heading">
        {t("project.notFound")}
      </p>
      <Link
        to="/"
        className="typography-label inline-flex h-[var(--size-control)] items-center rounded-[var(--radius-control)] bg-accent px-[var(--space-stack-gap)] text-on-accent hover:bg-accent-hover"
      >
        {t("errorPage.toHome")}
      </Link>
    </main>
  );
}
