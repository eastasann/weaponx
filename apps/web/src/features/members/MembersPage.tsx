import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/Button";
import { DataTable } from "../../components/DataTable";
import { ConfirmDialog } from "../../components/Dialog";
import { LoadError } from "../../components/LoadError";
import { useNotify, useNotifyError } from "../../components/Toast";
import { client, unwrap } from "../../lib/api";
import { describeError, toApiError } from "../../lib/errors";
import { formatDate, nameCollator } from "../../lib/format";
import { type MemberRow, membersQuery, meQuery, projectQuery } from "../../lib/queries";
import { useLocale } from "../../lib/use-locale";
import { useIsMobile } from "../../lib/use-media-query";
import { endsSession } from "../documents/failure";
import { DesktopOnly } from "../layout/DesktopOnly";
import { ProjectNotFound } from "../project/ProjectNotFound";
import { InviteDialog } from "./InviteDialog";

const route = getRouteApi("/_app/projects/$projectId/members");

type Role = MemberRow["role"];
const ROLES: Role[] = ["owner", "editor", "viewer"];
const ROLE_ORDER: Record<Role, number> = { owner: 0, editor: 1, viewer: 2 };

/** メンバー管理 U3(design-spec 6.5.2)。オーナーだけが変更でき、それ以外は読み取り専用 */
export function MembersPage() {
  const isMobile = useIsMobile();
  if (isMobile) return <DesktopOnly />;
  return <MembersView />;
}

function MembersView() {
  const { projectId } = route.useParams();
  const { t } = useTranslation();
  const locale = useLocale();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const notify = useNotify();
  const notifyError = useNotifyError();
  const { data: me } = useQuery(meQuery);
  const project = useQuery(projectQuery(projectId));
  const members = useQuery(membersQuery(projectId));

  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<MemberRow | null>(null);
  const [demoting, setDemoting] = useState<{ member: MemberRow; role: Role } | null>(null);

  const collator = useMemo(() => nameCollator(locale), [locale]);
  const rows = useMemo(
    () =>
      [...(members.data?.members ?? [])].sort(
        (a, b) =>
          ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
          collator.compare(a.displayName ?? a.email, b.displayName ?? b.email),
      ),
    [members.data, collator],
  );

  const proj = project.data?.project;
  const isOwner = proj?.myRole === "owner";
  const myId = me?.user.id;
  const ownerCount = rows.filter((member) => member.role === "owner").length;

  const reload = async () => {
    await queryClient.invalidateQueries({ queryKey: ["projects"] });
  };

  // 失敗の扱い(design-spec 6.0.2): 入力欄の無い操作は通知で理由を出し、表を読み直す。
  // 役割が下がった・外された場合は案件も読み直して、表示を新しい役割に合わせる
  const afterFailure = async (error: unknown) => {
    if (endsSession(error)) return;
    const { code } = describeError(error);
    if (code !== "PROJECT_NOT_FOUND") notifyError(error);
    await reload();
  };

  const changeRole = useMutation({
    mutationFn: (input: { userId: string; role: Role }) =>
      unwrap(
        client.api.projects({ projectId }).members({ userId: input.userId }).patch({
          role: input.role,
        }),
      ),
    onSuccess: async () => {
      notify({ kind: "success", message: t("members.changed") });
      await reload();
    },
    onError: afterFailure,
    onSettled: () => setDemoting(null),
  });

  const remove = useMutation({
    mutationFn: (userId: string) =>
      unwrap(client.api.projects({ projectId }).members({ userId }).delete()),
    onSuccess: async (_, userId) => {
      setRemoving(null);
      notify({ kind: "success", message: t("members.removed") });
      if (userId === myId) {
        // 自分を外したら、この案件はもう見られない。ホームへ戻る(design-spec 6.5.2)
        await navigate({ to: "/" });
        queryClient.removeQueries({ queryKey: ["projects", projectId] });
      }
      await reload();
    },
    onError: async (error) => {
      setRemoving(null);
      await afterFailure(error);
    },
  });

  // 案件が無い・参加していない・削除済みは区別せず、案件画面と同じ表示にする(design-spec 6.5.2)
  const gone = [project.error, members.error].some(
    (error) => error && toApiError(error).code === "PROJECT_NOT_FOUND",
  );
  if (gone) return <ProjectNotFound />;
  if (project.isError || members.isError) {
    return (
      <LoadError
        onReload={() => {
          void project.refetch();
          void members.refetch();
        }}
      />
    );
  }

  const onRoleSelect = (member: MemberRow, role: Role) => {
    if (role === member.role) return;
    if (member.userId === myId && role !== "owner") {
      setDemoting({ member, role });
      return;
    }
    changeRole.mutate({ userId: member.userId, role });
  };

  const showLastOwnerNote = isOwner && ownerCount === 1;
  const columns = [
    {
      key: "name",
      header: t("members.columns.name"),
      cell: (member: MemberRow) => (
        <span className="flex min-w-0 flex-wrap items-center gap-x-[var(--space-tight)]">
          <span className="min-w-0 break-words">
            {member.hasLoggedIn ? (member.displayName ?? member.email) : t("members.neverLoggedIn")}
          </span>
          {member.userId === myId && <span className="text-text-muted">{t("members.self")}</span>}
          {member.status === "suspended" && (
            <span className="text-text-muted">{t("members.suspended")}</span>
          )}
        </span>
      ),
    },
    {
      key: "email",
      header: t("members.columns.email"),
      cell: (member: MemberRow) => <span className="break-all">{member.email}</span>,
    },
    {
      key: "role",
      header: t("members.columns.role"),
      cell: (member: MemberRow) => {
        if (!isOwner) return t(`roles.${member.role}`);
        const lastOwner = member.role === "owner" && ownerCount === 1;
        return (
          <select
            aria-label={t("members.roleSelect", { name: member.displayName ?? member.email })}
            value={member.role}
            disabled={lastOwner || changeRole.isPending}
            onChange={(event) => onRoleSelect(member, event.target.value as Role)}
            className="typography-body h-[var(--size-control)] rounded-[var(--radius-control)] border border-border-strong bg-surface px-[var(--space-inline-gap)] disabled:opacity-60"
          >
            {ROLES.map((role) => (
              <option key={role} value={role}>
                {t(`roles.${role}`)}
              </option>
            ))}
          </select>
        );
      },
    },
    {
      key: "addedAt",
      header: t("members.columns.addedAt"),
      cell: (member: MemberRow) => formatDate(member.addedAt, locale),
    },
    ...(isOwner
      ? [
          {
            key: "actions",
            header: "",
            cell: (member: MemberRow) => (
              <Button
                disabled={member.role === "owner" && ownerCount === 1}
                onClick={() => setRemoving(member)}
              >
                {t("members.remove")}
              </Button>
            ),
          },
        ]
      : []),
  ];

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-[var(--size-toolbar)] items-center gap-[var(--space-inline-gap)] border-b border-border px-[var(--space-page-gutter)]">
        <Link
          to="/projects/$projectId"
          params={{ projectId }}
          className="typography-label shrink-0 text-link"
        >
          {t("members.back", { name: proj?.name ?? "" })}
        </Link>
        <h1 className="typography-page-title min-w-0 truncate">{t("members.title")}</h1>
        <span className="flex-1" />
        {isOwner && (
          <Button variant="primary" onClick={() => setInviting(true)}>
            {t("members.invite")}
          </Button>
        )}
      </div>
      <DataTable<MemberRow>
        loading={members.isPending || project.isPending}
        loadingRows={4}
        rows={rows}
        rowKey={(member) => member.userId}
        columns={columns}
      />
      {showLastOwnerNote && (
        <p className="typography-caption px-[var(--space-page-gutter)] py-[var(--space-inline-gap)] text-text-muted">
          {t("members.disabledNote", { reason: t("errors.LAST_OWNER") })}
        </p>
      )}
      {inviting && <InviteDialog projectId={projectId} onClose={() => setInviting(false)} />}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t("members.removeTitle")}
        message={
          removing?.userId === myId
            ? t("members.removeSelfMessage")
            : t("members.removeMessage", { name: removing?.displayName ?? removing?.email ?? "" })
        }
        confirmLabel={t("members.removeConfirm")}
        destructive
        pending={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing.userId)}
      />
      <ConfirmDialog
        open={demoting !== null}
        onOpenChange={(open) => !open && setDemoting(null)}
        title={t("members.selfDemoteTitle")}
        message={t("members.selfDemoteMessage", {
          role: demoting ? t(`roles.${demoting.role}`) : "",
        })}
        confirmLabel={t("members.selfDemoteConfirm")}
        pending={changeRole.isPending}
        onConfirm={() =>
          demoting && changeRole.mutate({ userId: demoting.member.userId, role: demoting.role })
        }
      />
    </main>
  );
}
