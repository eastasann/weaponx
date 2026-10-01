import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { safeReturnTo } from "@weaponx/shared";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/Button";
import { CenterCard } from "../../components/layouts";
import { useNotifyError } from "../../components/Toast";
import { client, unwrap } from "../../lib/api";
import { consumeNotice } from "../../lib/cookies";
import { toApiError } from "../../lib/errors";
import { setLocale } from "../../lib/i18n";
import type { Locale } from "../../lib/locale";
import { configQuery } from "../../lib/queries";
import { useLocale } from "../../lib/use-locale";

const NOTICE_CODES = [
  "not_allowed",
  "suspended",
  "drive_scope_missing",
  "cancelled",
  "failed",
] as const;
type NoticeCode = (typeof NOTICE_CODES)[number];
type Notice = { code: NoticeCode; email?: string };

function readNotice(): Notice | null {
  const notice = consumeNotice("wx_login_notice");
  const code = NOTICE_CODES.find((known) => known === notice?.code);
  if (!code) return null;
  return notice?.email === undefined ? { code } : { code, email: notice.email };
}

/** ログイン(design-spec 6.5.1)。P1 中央集中 */
export function LoginPage({ returnTo }: { returnTo: string | undefined }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const { data: config } = useQuery(configQuery);
  // 「ログインに失敗した」表示は、サーバーが置いた Cookie を1回だけ読んで出す
  const [notice, setNotice] = useState<Notice | null>(null);
  const [redirecting, setRedirecting] = useState(false);

  useEffect(() => {
    const read = readNotice();
    if (read) setNotice(read);
  }, []);

  const startGoogleLogin = () => {
    setRedirecting(true);
    const params = new URLSearchParams({ locale });
    if (returnTo) params.set("returnTo", returnTo);
    window.location.assign(`/api/auth/google/login?${params}`);
  };

  return (
    <CenterCard>
      <h1 className="typography-display">{t("app.name")}</h1>
      <p className="typography-body text-text-muted">{t("app.tagline")}</p>
      {notice && (
        <p
          role="alert"
          className="typography-body rounded-[var(--radius-control)] border border-danger bg-danger-surface p-[var(--space-inline-gap)] text-left text-danger"
        >
          {t(`login.notice.${notice.code}`, { email: notice.email })}
        </p>
      )}
      <Button variant="primary" loading={redirecting} onClick={startGoogleLogin} className="w-full">
        <span aria-hidden="true" className="font-bold">
          G
        </span>
        {t("login.button")}
      </Button>
      <p className="typography-caption text-text-muted">{t("login.hint")}</p>
      {config?.devLogin && (
        <DevLogin returnTo={returnTo} onSuspended={() => setNotice({ code: "suspended" })} />
      )}
      <fieldset className="flex items-center gap-[var(--space-inline-gap)]">
        <legend className="sr-only">{t("login.language")}</legend>
        <LanguageButton target="ja" current={locale} label={t("header.languageJa")} />
        <span aria-hidden="true" className="text-text-subtle">
          |
        </span>
        <LanguageButton target="en" current={locale} label={t("header.languageEn")} />
      </fieldset>
    </CenterCard>
  );
}

function LanguageButton({
  target,
  current,
  label,
}: {
  target: Locale;
  current: Locale;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={target === current}
      onClick={() => void setLocale(target)}
      className={`typography-label rounded-[var(--radius-control)] px-[var(--space-tight)] hover:bg-row-hover ${target === current ? "text-text" : "text-link"}`}
    >
      {label}
    </button>
  );
}

/** 開発用ログイン(02-01 5.10)。`/api/config` の `devLogin` のときだけ出す */
function DevLogin({
  returnTo,
  onSuspended,
}: {
  returnTo: string | undefined;
  onSuspended: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const notifyError = useNotifyError();
  const [pending, setPending] = useState<string | null>(null);
  const { data } = useQuery({
    queryKey: ["dev-users"],
    queryFn: () => unwrap(client.api.dev.users.get()),
    retry: false,
  });

  const login = async (email: string) => {
    setPending(email);
    try {
      await unwrap(client.api.dev.login.post({ email }));
      queryClient.removeQueries({ queryKey: ["me"] });
      await navigate({ href: safeReturnTo(returnTo) });
    } catch (error) {
      // 停止中の利用者は本物のログインと同じ表示を出す。サーバーが置いた Cookie は読み捨てる
      if (toApiError(error).code === "ACCOUNT_SUSPENDED") {
        consumeNotice("wx_login_notice");
        onSuspended();
      } else {
        notifyError(error);
      }
    } finally {
      setPending(null);
    }
  };

  return (
    <section className="flex w-full flex-col gap-[var(--space-inline-gap)] border-t border-border pt-[var(--space-stack-gap)] text-left">
      <h2 className="typography-section-heading">{t("login.dev.title")}</h2>
      <p className="typography-caption text-text-muted">{t("login.dev.hint")}</p>
      {data?.users.length === 0 && (
        <p className="typography-caption text-text-muted">{t("login.dev.empty")}</p>
      )}
      <ul className="flex flex-col gap-[var(--space-tight)]">
        {data?.users.map((user) => (
          <li key={user.id}>
            <Button
              className="h-auto w-full justify-between py-[var(--space-tight)]"
              loading={pending === user.email}
              disabled={pending !== null}
              onClick={() => login(user.email)}
            >
              <span className="flex flex-1 flex-col items-start">
                <span>{user.displayName ?? user.email}</span>
                <span className="typography-caption text-text-muted">{user.email}</span>
              </span>
              <span className="typography-caption text-text-muted">
                {user.status === "suspended"
                  ? t("login.dev.suspended")
                  : user.globalRole === "admin"
                    ? t("login.dev.admin")
                    : ""}
              </span>
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
