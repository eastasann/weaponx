import { type InputHTMLAttributes, useId } from "react";

type TextFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & {
  label: string;
  /** 欄の下に出す理由(design-spec 6.0.3) */
  error?: string | undefined;
  /** 見出しを画面に出さず、読み上げだけにする(ツールバーの絞り込み欄) */
  hideLabel?: boolean;
};

export function TextField({
  label,
  error,
  hideLabel = false,
  className = "",
  ...rest
}: TextFieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-[var(--space-tight)]">
      <label htmlFor={id} className={hideLabel ? "sr-only" : "typography-label"}>
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={`typography-body h-[var(--size-control)] rounded-[var(--radius-control)] border bg-surface px-[var(--space-inline-gap)] text-text placeholder:text-text-subtle focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring ${error ? "border-danger" : "border-border-strong"} ${className}`}
        {...rest}
      />
      {error && (
        <p id={errorId} className="typography-caption text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
