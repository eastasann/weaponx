import type { ReactNode } from "react";

/** P1 中央集中(design-spec 4.1)。ヘッダーなしで、画面中央に1枚のカードを置く */
export function CenterCard({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center p-[var(--space-page-gutter)]">
      <div className="flex w-[min(var(--size-dialog),100%)] flex-col items-center gap-[var(--space-section-gap)] rounded-[var(--radius-surface)] border border-border bg-surface p-[var(--space-dialog-padding)] text-center shadow-[var(--shadow-popover)]">
        {children}
      </div>
    </main>
  );
}

type ListPageProps = {
  title?: ReactNode;
  toolbar?: ReactNode;
  children: ReactNode;
};

/** P3 一覧(design-spec 4.1)。見出しとツールバーは固定し、表だけが縦にスクロールする */
export function ListPage({ title, toolbar, children }: ListPageProps) {
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-[var(--space-inline-gap)] px-[var(--space-page-gutter)] pt-[var(--space-page-gutter)]">
        {title && <h1 className="typography-page-title">{title}</h1>}
        {toolbar && (
          <div className="flex min-h-[var(--size-toolbar)] items-center gap-[var(--space-inline-gap)]">
            {toolbar}
          </div>
        )}
      </div>
      {children}
    </main>
  );
}

type ListWithPanelProps = {
  toolbar?: ReactNode;
  list: ReactNode;
  /** 選んだ1件の詳細。null なら閉じて、表が全幅に戻る */
  panel: ReactNode | null;
};

/**
 * P2 一覧 + 横パネル(design-spec 4.1・4.3)。1024px 以上は表の右に並べ、
 * 768〜1023px は表の上に重ねて右から出し(表の幅は縮めない)、768px 未満は全画面のシートにする。
 * 表と横パネルはそれぞれ独立して縦にスクロールする。
 */
export function ListWithPanel({ toolbar, list, panel }: ListWithPanelProps) {
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      {toolbar && (
        <div className="flex min-h-[var(--size-toolbar)] items-center gap-[var(--space-inline-gap)] px-[var(--space-page-gutter)]">
          {toolbar}
        </div>
      )}
      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">{list}</div>
        {panel !== null && (
          <aside className="absolute inset-y-0 right-0 z-20 w-[var(--size-side-panel)] max-w-full overflow-y-auto border-l border-border bg-surface p-[var(--space-panel-padding)] shadow-[var(--shadow-popover)] max-md:fixed max-md:inset-0 max-md:z-30 max-md:w-full lg:static lg:shrink-0 lg:shadow-none">
            {panel}
          </aside>
        )}
      </div>
    </main>
  );
}
