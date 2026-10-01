import { LIMITS, validateSingleLine } from "@weaponx/shared";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { TextField } from "../../components/TextField";
import { fieldErrors } from "../../lib/errors";

type NameDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  submitLabel: string;
  initialValue?: string;
  pending: boolean;
  /** 保存の失敗は呼び出し側が通知する。入力の問題は例外から欄の下に出す */
  onSubmit: (name: string) => Promise<void>;
};

/** 案件の名前の入力(案件を作る・案件名を変更)。入力規則は design-spec 6.0.3 */
export function NameDialog({
  open,
  onOpenChange,
  title,
  submitLabel,
  initialValue = "",
  pending,
  onSubmit,
}: NameDialogProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initialValue);
  const [touched, setTouched] = useState(false);
  const [serverError, setServerError] = useState<string | undefined>();

  const result = validateSingleLine(value, { max: LIMITS.projectName });
  const clientError = touched && !result.ok ? result.error : undefined;
  const message = clientError
    ? t(`errors.fields.${clientError}`, { max: LIMITS.projectName })
    : serverError;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!result.ok || pending) return;
    try {
      await onSubmit(result.value);
    } catch (error) {
      const field = fieldErrors(error).name;
      if (field) setServerError(t(`errors.fields.${field}`, { max: LIMITS.projectName }));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)} title={title}>
      <form onSubmit={submit} className="flex flex-col gap-[var(--space-stack-gap)]">
        <TextField
          label={t("createProject.nameLabel")}
          value={value}
          error={message}
          autoFocus
          onChange={(event) => {
            setValue(event.target.value);
            setTouched(true);
            setServerError(undefined);
          }}
        />
        <div className="flex justify-end gap-[var(--space-inline-gap)]">
          <Button disabled={pending} onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" loading={pending} disabled={!result.ok}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
