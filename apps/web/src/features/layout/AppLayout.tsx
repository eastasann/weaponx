import { useQuery } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNotify } from "../../components/Toast";
import { consumeNotice } from "../../lib/cookies";
import { setLocale } from "../../lib/i18n";
import { isLocale } from "../../lib/locale";
import { meQuery } from "../../lib/queries";
import { ReauthBanner } from "./ReauthBanner";
import { UserMenu } from "./UserMenu";

const DRIVE_NOTICES = [
  "reconnected",
  "cancelled",
  "failed",
  "wrong_account",
  "scope_missing",
] as const;

/** ログイン・エラー以外の全画面に共通の要素(design-spec 3.5): ヘッダー、ユーザーメニュー、要再連携の帯 */
export function AppLayout() {
  const { t } = useTranslation();
  const notify = useNotify();
  const { data: me } = useQuery(meQuery);
  const locale = me?.user.locale;

  // 設定に値があればそれを表示言語にする(design-spec 1.2)
  useEffect(() => {
    if (isLocale(locale)) void setLocale(locale);
  }, [locale]);

  // 再連携から戻ったときの結果の通知(design-spec 6.0.5)。Cookie は1回読んで消す
  const email = me?.user.email;
  useEffect(() => {
    if (!email) return;
    const notice = consumeNotice("wx_drive_notice");
    const code = DRIVE_NOTICES.find((known) => known === notice?.code);
    if (!code) return;
    notify({
      kind: code === "reconnected" ? "success" : "error",
      message: t(`notice.drive.${code}`, { email }),
    });
  }, [email, notify, t]);

  if (!me) return null;
  return (
    <div className="flex h-screen flex-col">
      <header className="flex h-[var(--size-header)] shrink-0 items-center justify-between border-b border-border bg-surface px-[var(--space-page-gutter)]">
        <Link to="/" className="typography-app-name text-text">
          {t("app.name")}
        </Link>
        <UserMenu me={me} />
      </header>
      {me.drive.status === "needs_reauth" && <ReauthBanner />}
      <Outlet />
    </div>
  );
}
