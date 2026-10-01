import { Dialog as RadixDialog } from "radix-ui";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./Button";

type DialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
};

/** パターン D のダイアログ(design-spec 4.1)。フォーカス管理・Esc・背面の操作不可は Radix が行う */
export function Dialog({ open, onOpenChange, title, description, children, footer }: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-scrim" />
        <RadixDialog.Content
          {...(description ? {} : { "aria-describedby": undefined })}
          className="fixed top-1/2 left-1/2 z-40 flex max-h-[calc(100vh-2*var(--space-page-gutter))] w-[min(var(--size-dialog),calc(100vw-2*var(--space-page-gutter)))] -translate-x-1/2 -translate-y-1/2 flex-col gap-[var(--space-stack-gap)] overflow-y-auto rounded-[var(--radius-surface)] border border-border bg-surface p-[var(--space-dialog-padding)] text-text shadow-[var(--shadow-dialog)]"
        >
          <RadixDialog.Title className="typography-dialog-title">{title}</RadixDialog.Title>
          {description && (
            <RadixDialog.Description className="typography-body text-text-muted">
              {description}
            </RadixDialog.Description>
          )}
          {children}
          {footer && <div className="flex justify-end gap-[var(--space-inline-gap)]">{footer}</div>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  message: ReactNode;
  confirmLabel: string;
  /** 破壊的な操作(削除・外す・停止)は危険色のボタンにする */
  destructive?: boolean;
  /** 実行中は確認ボタンを読み込み中にし、ダイアログは閉じない(design-spec 6.0.1) */
  pending?: boolean;
  onConfirm: () => void;
};

/** 取り消しにくい操作の前の確認(design-spec 3.4) */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  message,
  confirmLabel,
  destructive = false,
  pending = false,
  onConfirm,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
      title={title}
      description={message}
      footer={
        <>
          <Button disabled={pending} onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            variant={destructive ? "danger" : "primary"}
            loading={pending}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}
