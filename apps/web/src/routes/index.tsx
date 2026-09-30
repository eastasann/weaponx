import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const { t } = useTranslation();
  return (
    <main className="p-4">
      <h1 className="typography-page-title">{t("app.name")}</h1>
      <p className="typography-body text-text-muted">{t("home.tagline")}</p>
    </main>
  );
}
