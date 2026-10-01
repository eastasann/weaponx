import { Toast as RadixToast } from "radix-ui";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeError, toApiError } from "../lib/errors";

export type Notice = {
  kind: "success" | "error";
  message: string;
  /** 失敗の詳細(問い合わせのときに照合するリクエスト ID。02-01 8章「ログとの対応」) */
  requestId?: string;
};

type Entry = Notice & { id: number };

const NotifyContext = createContext<(notice: Notice) => void>(() => {});

/** 画面上部の通知(design-spec 3.5・6.0.1)。成功は数秒で消え、失敗は自分で閉じるまで残る */
export function useNotify(): (notice: Notice) => void {
  return useContext(NotifyContext);
}

/** `--duration-toast`(トークン)の値をミリ秒で読む */
function successDuration(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--duration-toast");
  const ms = Number.parseFloat(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : 4000;
}

/** 失敗を通知で出す(文言は design-spec 6.0.2 の分類に従う。リクエスト ID を添える) */
export function useNotifyError(): (error: unknown, mode?: "read" | "write") => void {
  const notify = useNotify();
  const { t } = useTranslation();
  return useCallback(
    (error, mode = "write") =>
      notify({
        kind: "error",
        message: t(describeError(error, mode).messageKey),
        requestId: toApiError(error).requestId,
      }),
    [notify, t],
  );
}

let nextId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<Entry[]>([]);

  const notify = useCallback((notice: Notice) => {
    setEntries((current) => [...current, { ...notice, id: nextId++ }]);
  }, []);
  const remove = (id: number) => setEntries((current) => current.filter((e) => e.id !== id));
  const value = useMemo(() => notify, [notify]);

  return (
    <NotifyContext.Provider value={value}>
      <RadixToast.Provider swipeDirection="up">
        {children}
        {entries.map((entry) => (
          <RadixToast.Root
            key={entry.id}
            type={entry.kind === "error" ? "foreground" : "background"}
            duration={entry.kind === "error" ? Number.POSITIVE_INFINITY : successDuration()}
            onOpenChange={(open) => {
              if (!open) remove(entry.id);
            }}
            className={`typography-body flex items-start gap-[var(--space-inline-gap)] rounded-[var(--radius-surface)] border p-[var(--space-stack-gap)] shadow-[var(--shadow-popover)] ${
              entry.kind === "error"
                ? "border-danger bg-danger-surface text-danger"
                : "border-selected-border bg-success-surface text-success"
            }`}
          >
            <div className="flex-1">
              <RadixToast.Description>{entry.message}</RadixToast.Description>
              {entry.requestId && (
                <p className="typography-caption mt-[var(--space-tight)] text-text-muted">
                  {t("notice.requestId", { id: entry.requestId })}
                </p>
              )}
            </div>
            {entry.kind === "error" && (
              <RadixToast.Close
                aria-label={t("common.close")}
                className="typography-label rounded-[var(--radius-control)] px-[var(--space-tight)] hover:bg-row-hover"
              >
                ×
              </RadixToast.Close>
            )}
          </RadixToast.Root>
        ))}
        <RadixToast.Viewport className="fixed top-[var(--space-page-gutter)] left-1/2 z-50 flex w-[min(var(--size-dialog),calc(100vw-2*var(--space-page-gutter)))] -translate-x-1/2 flex-col gap-[var(--space-inline-gap)]" />
      </RadixToast.Provider>
    </NotifyContext.Provider>
  );
}
