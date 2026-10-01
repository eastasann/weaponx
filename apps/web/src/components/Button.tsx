import type { ButtonHTMLAttributes } from "react";
import { useTranslation } from "react-i18next";

type Variant = "primary" | "secondary" | "danger" | "ghost";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-on-accent hover:bg-accent-hover",
  secondary: "border border-border-strong bg-surface text-text hover:bg-row-hover",
  danger: "bg-danger-solid text-on-danger hover:bg-danger-solid-hover",
  ghost: "text-text-muted hover:bg-row-hover",
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  /** 操作中。読み込み中の表示にして、同じボタンを押せなくする(design-spec 6.0.1) */
  loading?: boolean;
};

export function Button({
  variant = "secondary",
  loading = false,
  disabled,
  className = "",
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  const { t } = useTranslation();
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`typography-label inline-flex h-[var(--size-control)] items-center justify-center gap-[var(--space-inline-gap)] rounded-[var(--radius-control)] px-[var(--space-stack-gap)] transition-colors duration-[var(--motion-fast-duration)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
      {...rest}
    >
      {loading && (
        <span
          role="status"
          aria-label={t("common.loading")}
          className="size-[var(--size-icon)] animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      )}
      {children}
    </button>
  );
}
