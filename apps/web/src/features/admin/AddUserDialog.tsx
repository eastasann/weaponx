import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FieldError, LIMITS, validateEmail } from "@weaponx/shared";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { TextField } from "../../components/TextField";
import { useNotify } from "../../components/Toast";
import { client, unwrap } from "../../lib/api";
import { describeError, fieldErrors } from "../../lib/errors";
import { endsSession } from "../documents/failure";
import { FailureAlert } from "../documents/notices";

/** 利用者を追加ダイアログ(design-spec 6.5.4)。メールアドレス1件と、管理者にするかどうか */
export function AddUserDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const notify = useNotify();
  const [email, setEmail] = useState("");
  const [admin, setAdmin] = useState(false);
  const [touched, setTouched] = useState(false);
  const [serverError, setServerError] = useState<string | undefined>();
  const [alert, setAlert] = useState<string | null>(null);

  const result = validateEmail(email);
  const reason = (error: FieldError) =>
    error === "invalid_format"
      ? t("adminUsers.emailInvalid")
      : t(`errors.fields.${error}`, { max: LIMITS.email });
  const message = touched && !result.ok ? reason(result.error) : serverError;

  const add = useMutation({
    mutationFn: (input: { email: string; admin: boolean }) =>
      unwrap(client.api.admin.users.post(input)),
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!result.ok || add.isPending) return;
    setAlert(null);
    try {
      await add.mutateAsync({ email: result.value, admin });
      notify({ kind: "success", message: t("adminUsers.added") });
      onClose();
      await queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
    } catch (error) {
      if (endsSession(error)) return;
      const { code, category, messageKey } = describeError(error);
      const field = fieldErrors(error).email;
      if (code === "EMAIL_TAKEN") setServerError(t("errors.EMAIL_TAKEN"));
      else if (field) setServerError(reason(field));
      else if (category === "forbidden") {
        // 管理者を外された: ダイアログを閉じ、画面を権限なしの表示にする(design-spec 6.0.2)
        onClose();
        await queryClient.invalidateQueries({ queryKey: ["me"] });
        await queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
      } else setAlert(t(messageKey));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !add.isPending && onClose()}
      title={t("adminUsers.addTitle")}
    >
      <form onSubmit={submit} className="flex flex-col gap-[var(--space-stack-gap)]">
        {alert && <FailureAlert>{alert}</FailureAlert>}
        <TextField
          type="email"
          label={t("adminUsers.email")}
          value={email}
          error={message}
          autoFocus
          onChange={(event) => {
            setEmail(event.target.value);
            setTouched(true);
            setServerError(undefined);
          }}
        />
        <label className="typography-body flex items-center gap-[var(--space-inline-gap)]">
          <input
            type="checkbox"
            checked={admin}
            onChange={(event) => setAdmin(event.target.checked)}
          />
          {t("adminUsers.asAdmin")}
        </label>
        <div className="flex justify-end gap-[var(--space-inline-gap)]">
          <Button disabled={add.isPending} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" loading={add.isPending} disabled={!result.ok}>
            {t("adminUsers.addSubmit")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
