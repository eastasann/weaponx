import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { normalizeKey } from "@weaponx/shared";
import { DropdownMenu } from "radix-ui";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/Button";
import { DataTable } from "../../components/DataTable";
import { LoadError } from "../../components/LoadError";
import { TextField } from "../../components/TextField";
import { useNotify, useNotifyError } from "../../components/Toast";
import { client, unwrap } from "../../lib/api";
import { describeError, toApiError } from "../../lib/errors";
import { formatDateTime, nameCollator } from "../../lib/format";
import { type AdminUserRow, adminUsersQuery, meQuery } from "../../lib/queries";
import { useLocale } from "../../lib/use-locale";
import { useIsMobile } from "../../lib/use-media-query";
import { endsSession } from "../documents/failure";
import { DesktopOnly } from "../layout/DesktopOnly";
import { AddUserDialog } from "./AddUserDialog";
import { SuspendDialog } from "./SuspendDialog";

const ITEM =
  "typography-body flex min-h-[var(--size-control)] cursor-pointer items-center rounded-[var(--radius-control)] px-[var(--space-inline-gap)] outline-none data-[highlighted]:bg-row-hover";

/** 利用者管理 A1(design-spec 6.5.4)。管理者だけ */
export function AdminUsersPage() {
  const isMobile = useIsMobile();
  if (isMobile) return <DesktopOnly />;
  return <AdminUsersView />;
}

/** 管理者でない人が開いた・管理者を外された人の表示(design-spec 6.5.4) */
function NoPermission() {
  const { t } = useTranslation();
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-[var(--space-stack-gap)] p-[var(--space-page-gutter)] text-center">
      <p role="alert" className="typography-section-heading">
        {t("adminUsers.noPermission")}
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

function AdminUsersView() {
  const { t } = useTranslation();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const notify = useNotify();
  const notifyError = useNotifyError();
  const { data: me } = useQuery(meQuery);
  const users = useQuery(adminUsersQuery);

  const [filter, setFilter] = useState("");
  const [adding, setAdding] = useState(false);
  const [suspending, setSuspending] = useState<AdminUserRow | null>(null);

  const collator = useMemo(() => nameCollator(locale), [locale]);
  const rows = useMemo(() => {
    const key = normalizeKey(filter.trim());
    const shown = (users.data?.users ?? []).filter(
      (user) =>
        key === "" ||
        normalizeKey(user.displayName ?? "").includes(key) ||
        normalizeKey(user.email).includes(key),
    );
    // 有効な利用者を先に、その中は名前順。未ログインはメール順で末尾(design-spec 6.5.4)
    const rank = (user: AdminUserRow) =>
      (user.status === "active" ? 0 : 2) + (user.hasLoggedIn ? 0 : 1);
    return shown.sort(
      (a, b) =>
        rank(a) - rank(b) ||
        collator.compare(
          a.hasLoggedIn ? (a.displayName ?? a.email) : a.email,
          b.hasLoggedIn ? (b.displayName ?? b.email) : b.email,
        ),
    );
  }, [users.data, filter, collator]);

  const reload = () => queryClient.invalidateQueries({ queryKey: ["admin", "users"] });

  // 失敗の扱い(design-spec 6.0.2): 管理者を外されていたら権限なしの表示にする。ほかは通知で理由を出して読み直す
  const afterFailure = async (error: unknown) => {
    if (endsSession(error)) return;
    if (describeError(error).code === "ADMIN_REQUIRED") {
      // ユーザーメニューの「利用者管理」も、最新の権限で出し直す
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    } else {
      notifyError(error);
    }
    await reload();
  };

  const update = useMutation({
    mutationFn: (input: {
      userId: string;
      body: { status: "active" | "suspended" } | { globalRole: "admin" | "member" };
    }) => unwrap(client.api.admin.users({ userId: input.userId }).patch(input.body)),
    onSuccess: async (_, input) => {
      const body = input.body;
      const message =
        "status" in body
          ? body.status === "suspended"
            ? "adminUsers.suspended"
            : "adminUsers.resumed"
          : body.globalRole === "admin"
            ? "adminUsers.adminGranted"
            : "adminUsers.adminRevoked";
      notify({ kind: "success", message: t(message) });
      setSuspending(null);
      await reload();
    },
    onError: async (error) => {
      setSuspending(null);
      await afterFailure(error);
    },
  });

  if (users.isError) {
    return toApiError(users.error).code === "ADMIN_REQUIRED" ? (
      <NoPermission />
    ) : (
      <LoadError onReload={() => void users.refetch()} />
    );
  }

  const columns = [
    {
      key: "name",
      header: t("adminUsers.columns.name"),
      cell: (user: AdminUserRow) => (
        <span className="flex min-w-0 flex-wrap items-center gap-x-[var(--space-tight)]">
          <span className="min-w-0 break-words">
            {user.hasLoggedIn ? (user.displayName ?? user.email) : t("adminUsers.neverLoggedIn")}
          </span>
          {user.id === me?.user.id && (
            <span className="text-text-muted">{t("adminUsers.self")}</span>
          )}
        </span>
      ),
    },
    {
      key: "email",
      header: t("adminUsers.columns.email"),
      cell: (user: AdminUserRow) => <span className="break-all">{user.email}</span>,
    },
    {
      key: "role",
      header: t("adminUsers.columns.role"),
      cell: (user: AdminUserRow) => t(`adminUsers.globalRoles.${user.globalRole}`),
    },
    {
      key: "status",
      header: t("adminUsers.columns.status"),
      cell: (user: AdminUserRow) => t(`adminUsers.statuses.${user.status}`),
    },
    {
      key: "lastLogin",
      header: t("adminUsers.columns.lastLogin"),
      cell: (user: AdminUserRow) =>
        user.lastLoginAt ? formatDateTime(user.lastLoginAt, locale) : t("adminUsers.noLogin"),
    },
    {
      key: "actions",
      header: "",
      cell: (user: AdminUserRow) => (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            aria-label={t("adminUsers.menu", { name: user.displayName ?? user.email })}
            disabled={user.id === me?.user.id}
            className="typography-label h-[var(--size-control)] w-[var(--size-control)] rounded-[var(--radius-control)] hover:bg-row-hover focus-visible:outline-2 focus-visible:outline-focus-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            ⋯
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={4}
              className="z-30 rounded-[var(--radius-surface)] border border-border bg-surface p-[var(--space-tight)] text-text shadow-[var(--shadow-popover)]"
            >
              {user.status === "active" ? (
                <DropdownMenu.Item className={ITEM} onSelect={() => setSuspending(user)}>
                  {t("adminUsers.suspend")}
                </DropdownMenu.Item>
              ) : (
                <DropdownMenu.Item
                  className={ITEM}
                  onSelect={() => update.mutate({ userId: user.id, body: { status: "active" } })}
                >
                  {t("adminUsers.resume")}
                </DropdownMenu.Item>
              )}
              <DropdownMenu.Item
                className={ITEM}
                onSelect={() =>
                  update.mutate({
                    userId: user.id,
                    body: { globalRole: user.globalRole === "admin" ? "member" : "admin" },
                  })
                }
              >
                {user.globalRole === "admin"
                  ? t("adminUsers.removeAdmin")
                  : t("adminUsers.makeAdmin")}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      ),
    },
  ];

  const selfVisible = rows.some((user) => user.id === me?.user.id);

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-[var(--size-toolbar)] items-center gap-[var(--space-inline-gap)] border-b border-border px-[var(--space-page-gutter)]">
        <h1 className="typography-page-title min-w-0 truncate">{t("adminUsers.title")}</h1>
        <span className="flex-1" />
        <Button variant="primary" onClick={() => setAdding(true)}>
          {t("adminUsers.add")}
        </Button>
      </div>
      <div className="flex min-h-[var(--size-toolbar)] items-center px-[var(--space-page-gutter)]">
        <TextField
          type="search"
          hideLabel
          label={t("adminUsers.filterLabel")}
          placeholder={t("adminUsers.filterPlaceholder")}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          className="w-64 max-w-full"
        />
      </div>
      <DataTable<AdminUserRow>
        loading={users.isPending}
        loadingRows={5}
        rows={rows}
        rowKey={(user) => user.id}
        columns={columns}
        empty={filter.trim() !== "" ? t("adminUsers.filteredEmpty") : undefined}
      />
      {selfVisible && (
        <p className="typography-caption px-[var(--space-page-gutter)] py-[var(--space-inline-gap)] text-text-muted">
          {t("adminUsers.selfNote")}
        </p>
      )}
      {adding && <AddUserDialog onClose={() => setAdding(false)} />}
      {suspending && (
        <SuspendDialog
          user={suspending}
          pending={update.isPending}
          onClose={() => setSuspending(null)}
          onConfirm={() => update.mutate({ userId: suspending.id, body: { status: "suspended" } })}
        />
      )}
    </main>
  );
}
