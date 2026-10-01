import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../../components/Dialog";
import { client, unwrap } from "../../lib/api";
import type { AdminUserRow } from "../../lib/queries";

type Props = {
  user: AdminUserRow;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
};

/**
 * 停止の確認ダイアログ(design-spec 6.5.4)。この人が唯一のオーナーの案件があれば、
 * 停止すると何ができなくなるかを警告色で添える。案件名は出さない
 */
export function SuspendDialog({ user, pending, onClose, onConfirm }: Props) {
  const { t } = useTranslation();
  const soleOwner = useQuery({
    queryKey: ["admin", "users", user.id, "sole-owner-count"],
    queryFn: () => unwrap(client.api.admin.users({ userId: user.id })["sole-owner-count"].get()),
    retry: false,
    gcTime: 0,
  });
  const count = soleOwner.data?.count ?? 0;

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("adminUsers.suspendTitle")}
      message={
        <span className="flex flex-col gap-[var(--space-inline-gap)]">
          <span>{t("adminUsers.suspendMessage", { email: user.email })}</span>
          {count > 0 && (
            <span role="alert" className="text-warning">
              {t("adminUsers.soleOwner", { count })}
            </span>
          )}
          {soleOwner.isError && (
            <span role="alert" className="text-warning">
              {t("adminUsers.soleOwnerFailed")}
            </span>
          )}
        </span>
      }
      confirmLabel={t("adminUsers.suspendConfirm")}
      destructive
      pending={pending || soleOwner.isPending}
      onConfirm={onConfirm}
    />
  );
}
