import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LIMITS } from "@weaponx/shared";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { TextField } from "../../components/TextField";
import { useNotify } from "../../components/Toast";
import { client, unwrap } from "../../lib/api";
import { describeError, toApiError } from "../../lib/errors";
import { useDebouncedValue } from "../../lib/use-debounced-value";
import { endsSession } from "../documents/failure";
import { FailureAlert } from "../documents/notices";

type Role = "owner" | "editor" | "viewer";
const ROLES: Role[] = ["owner", "editor", "viewer"];

type Candidate = { id: string; email: string; displayName: string | null };

/** メンバーを招待ダイアログ(design-spec 6.5.2)。有効な利用者のうち、まだメンバーでない人を選んで役割を付ける */
export function InviteDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const notify = useNotify();
  const [input, setInput] = useState("");
  const q = useDebouncedValue(input.trim());
  const [chosen, setChosen] = useState<Candidate | null>(null);
  const [role, setRole] = useState<Role>("editor");
  const [alert, setAlert] = useState<string | null>(null);
  // 招待しようとした人についての入力の問題。候補の欄の下に出す(design-spec 6.0.2)
  const [chosenError, setChosenError] = useState<string | null>(null);

  const candidates = useQuery({
    queryKey: ["projects", projectId, "member-candidates", q],
    queryFn: () =>
      unwrap(client.api.projects({ projectId })["member-candidates"].get({ query: { q } })),
    retry: false,
    gcTime: 0,
  });
  const users = candidates.data?.users ?? [];

  const invite = useMutation({
    mutationFn: (input: { userId: string; role: Role }) =>
      unwrap(client.api.projects({ projectId }).members.post(input)),
  });

  const reload = () => queryClient.invalidateQueries({ queryKey: ["projects"] });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!chosen || invite.isPending) return;
    setAlert(null);
    setChosenError(null);
    try {
      await invite.mutateAsync({ userId: chosen.id, role });
      notify({ kind: "success", message: t("members.invited") });
      onClose();
      await reload();
    } catch (error) {
      if (endsSession(error)) return;
      const { category, code, messageKey } = describeError(error);
      const name = chosen.displayName ?? chosen.email;
      // 入力の問題: ダイアログは閉じず、入力を保つ。すでにメンバーだったときは表と候補を読み直す
      if (code === "ALREADY_MEMBER") {
        setChosen(null);
        void candidates.refetch();
        await reload();
        setChosenError(t("errors.ALREADY_MEMBER", { name }));
      } else if (code === "USER_SUSPENDED") {
        setChosenError(t("errors.USER_SUSPENDED", { name }));
      } else if (category === "not_found" || category === "forbidden") {
        // 案件が無くなった・役割が足りなくなった: ダイアログを閉じて画面を読み直す(design-spec 6.0.2)
        onClose();
        await reload();
        if (code !== "PROJECT_NOT_FOUND") {
          notify({ kind: "error", message: t(messageKey), requestId: toApiError(error).requestId });
        }
      } else {
        setAlert(t(messageKey));
      }
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !invite.isPending && onClose()}
      title={t("members.inviteTitle")}
    >
      <form onSubmit={submit} className="flex flex-col gap-[var(--space-stack-gap)]">
        {alert && <FailureAlert>{alert}</FailureAlert>}
        <TextField
          type="search"
          label={t("members.inviteSearch")}
          value={input}
          maxLength={LIMITS.searchQuery}
          onChange={(event) => setInput(event.target.value)}
        />
        <fieldset className="max-h-56 min-w-0 overflow-y-auto rounded-[var(--radius-control)] border border-border">
          <legend className="sr-only">{t("members.candidates")}</legend>
          {candidates.isError ? (
            <p role="alert" className="typography-body p-[var(--space-inline-gap)] text-text-muted">
              {t("errors.loadFailed")}
            </p>
          ) : candidates.isPending || input.trim() !== q ? (
            <p className="typography-body p-[var(--space-inline-gap)] text-text-muted">
              {t("common.loading")}
            </p>
          ) : users.length === 0 ? (
            <p className="typography-body p-[var(--space-inline-gap)] text-text-muted">
              {t("members.noCandidates")}
            </p>
          ) : (
            <ul>
              {users.map((user) => (
                <li key={user.id}>
                  <label className="typography-body flex cursor-pointer items-center gap-[var(--space-inline-gap)] px-[var(--space-inline-gap)] py-[var(--space-tight)] hover:bg-row-hover">
                    <input
                      type="radio"
                      name="candidate"
                      checked={chosen?.id === user.id}
                      onChange={() => {
                        setChosen(user);
                        setAlert(null);
                        setChosenError(null);
                      }}
                    />
                    <span className="min-w-0 break-words">{user.displayName ?? user.email}</span>
                    {user.displayName && (
                      <span className="min-w-0 break-all text-text-muted">{user.email}</span>
                    )}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </fieldset>
        {chosenError && (
          <p role="alert" className="typography-caption text-danger">
            {chosenError}
          </p>
        )}
        {users.length >= LIMITS.candidates && (
          <p className="typography-caption text-text-muted">{t("members.moreCandidates")}</p>
        )}
        <label className="typography-label flex flex-col gap-[var(--space-tight)]">
          {t("members.inviteRole")}
          <select
            value={role}
            onChange={(event) => setRole(event.target.value as Role)}
            className="typography-body h-[var(--size-control)] rounded-[var(--radius-control)] border border-border-strong bg-surface px-[var(--space-inline-gap)] text-text"
          >
            {ROLES.map((value) => (
              <option key={value} value={value}>
                {t(`roles.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <div className="flex justify-end gap-[var(--space-inline-gap)]">
          <Button disabled={invite.isPending} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" loading={invite.isPending} disabled={!chosen}>
            {t("members.inviteSubmit")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
