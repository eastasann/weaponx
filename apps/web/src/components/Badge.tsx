import type { ReactNode } from "react";

/** タグ・旧版などの小さなバッジ */
export function Badge({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="typography-caption inline-flex shrink-0 items-center rounded-[var(--radius-chip)] bg-badge px-[var(--space-inline-gap)] text-badge-text"
    >
      {children}
    </span>
  );
}
