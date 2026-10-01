import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { CenterCard } from "../../components/layouts";
import { meQuery } from "../../lib/queries";

/**
 * エラー(design-spec 6.5.7)。P1 中央集中。戻り先はログイン中ならホーム、未ログインならログイン。
 * 想定外の障害は状態が壊れているおそれがあるので、画面を読み直して戻る。
 */
export function ErrorPage({ kind }: { kind: "notFound" | "unexpected" }) {
  const { t } = useTranslation();
  const { data: me, isPending } = useQuery(meQuery);
  return (
    <CenterCard>
      <h1 className="typography-dialog-title" role={kind === "unexpected" ? "alert" : undefined}>
        {t(`errorPage.${kind}`)}
      </h1>
      {!isPending && (
        <a
          href={me ? "/" : "/login"}
          className="typography-label inline-flex h-[var(--size-control)] items-center rounded-[var(--radius-control)] bg-accent px-[var(--space-stack-gap)] text-on-accent hover:bg-accent-hover"
        >
          {me ? t("errorPage.toHome") : t("errorPage.toLogin")}
        </a>
      )}
    </CenterCard>
  );
}
