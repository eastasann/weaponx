import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Avatar, DropdownMenu } from "radix-ui";
import { useTranslation } from "react-i18next";
import { useNotifyError } from "../../components/Toast";
import { client, unwrap } from "../../lib/api";
import { toApiError } from "../../lib/errors";
import type { Me } from "../../lib/queries";
import { useLocale } from "../../lib/use-locale";
import { useLocaleSwitch } from "./useLocaleSwitch";

const ITEM =
  "typography-body flex min-h-[var(--size-control)] cursor-pointer items-center rounded-[var(--radius-control)] px-[var(--space-inline-gap)] outline-none data-[highlighted]:bg-row-hover";

/** ユーザーメニュー(design-spec 3.5)。表示言語・利用者管理(管理者だけ。モバイルでは出さない)・ログアウト */
export function UserMenu({ me }: { me: Me }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const switchLocale = useLocaleSwitch();
  const name = me.user.displayName ?? me.user.email;

  const notifyError = useNotifyError();
  const logout = useMutation({
    mutationFn: () => unwrap(client.api.auth.logout.post()),
    onSuccess: async () => {
      queryClient.clear();
      await navigate({ to: "/login" });
    },
    // セッションが切れていれば全体の処理がログイン画面へ送る(6.0.7)ので、それ以外だけ知らせる
    onError: (error) => {
      if (toApiError(error).code !== "UNAUTHENTICATED") notifyError(error);
    },
  });

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        aria-label={`${t("header.userMenu")}: ${name}`}
        title={name}
        className="rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
      >
        <Avatar.Root className="inline-flex size-[var(--size-avatar)] items-center justify-center overflow-hidden rounded-full bg-badge text-badge-text">
          {me.user.avatarUrl && (
            <Avatar.Image src={me.user.avatarUrl} alt="" referrerPolicy="no-referrer" />
          )}
          <Avatar.Fallback className="typography-label">
            {name.slice(0, 1).toUpperCase()}
          </Avatar.Fallback>
        </Avatar.Root>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-30 rounded-[var(--radius-surface)] border border-border bg-surface p-[var(--space-tight)] text-text shadow-[var(--shadow-popover)]"
        >
          <DropdownMenu.Label className="typography-caption px-[var(--space-inline-gap)] py-[var(--space-tight)] text-text-muted">
            {name}
            <br />
            {me.user.email}
          </DropdownMenu.Label>
          <DropdownMenu.Separator className="my-[var(--space-tight)] h-px bg-border" />
          <DropdownMenu.Label className="typography-caption px-[var(--space-inline-gap)] py-[var(--space-tight)] text-text-muted">
            {t("header.language")}
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            value={locale}
            onValueChange={(value) => switchLocale.mutate(value === "en" ? "en" : "ja")}
          >
            <DropdownMenu.RadioItem value="ja" className={ITEM}>
              <DropdownMenu.ItemIndicator className="w-[var(--size-icon)]">
                ✓
              </DropdownMenu.ItemIndicator>
              <span className={locale === "ja" ? "" : "pl-[var(--size-icon)]"}>
                {t("header.languageJa")}
              </span>
            </DropdownMenu.RadioItem>
            <DropdownMenu.RadioItem value="en" className={ITEM}>
              <DropdownMenu.ItemIndicator className="w-[var(--size-icon)]">
                ✓
              </DropdownMenu.ItemIndicator>
              <span className={locale === "en" ? "" : "pl-[var(--size-icon)]"}>
                {t("header.languageEn")}
              </span>
            </DropdownMenu.RadioItem>
          </DropdownMenu.RadioGroup>
          <DropdownMenu.Separator className="my-[var(--space-tight)] h-px bg-border" />
          {me.user.globalRole === "admin" && (
            <DropdownMenu.Item
              className={`${ITEM} max-md:hidden`}
              onSelect={() => navigate({ to: "/admin/users" })}
            >
              {t("header.adminUsers")}
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Item className={ITEM} onSelect={() => logout.mutate()}>
            {t("header.logout")}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
