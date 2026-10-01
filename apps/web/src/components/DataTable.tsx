import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { nameCollator } from "../lib/format";
import { useLocale } from "../lib/use-locale";

export type Column<Row> = {
  key: string;
  header: string;
  /** 列見出しを押して並べ替えられる列。値の型で比べ方が決まる(文字列は表示言語の辞書順) */
  sortValue?: (row: Row) => string | number | null;
  cell: (row: Row) => ReactNode;
  /** 数字・日付の列(桁をそろえる) */
  numeric?: boolean;
  className?: string;
  /** モバイル(<768px)で隠す列(design-spec 6.6) */
  hideOnMobile?: boolean;
};

type Sort = { key: string; direction: "asc" | "desc" };

type DataTableProps<Row> = {
  columns: Column<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  /** 読み込み中は灰色の仮の行をこの数だけ出す(design-spec 6.0.1) */
  loadingRows?: number;
  loading?: boolean;
  selectedKey?: string | null;
  onRowClick?: (row: Row) => void;
  /** 行にマウスを載せたときに出す「開く ↗」の行き先。元の場所を別タブで開く(design-spec 1.3) */
  openHref?: (row: Row) => string | null;
  empty?: ReactNode;
  initialSort?: Sort;
};

function compare(a: string | number | null, b: string | number | null, collator: Intl.Collator) {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return collator.compare(String(a), String(b));
}

/** 高密度の表(design-spec 4.4)。縦にスクロールするときも列見出しは固定する */
export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  loadingRows = 5,
  loading = false,
  selectedKey = null,
  onRowClick,
  openHref,
  empty,
  initialSort,
}: DataTableProps<Row>) {
  const { t } = useTranslation();
  const [sort, setSort] = useState<Sort | null>(initialSort ?? null);
  const locale = useLocale();

  const sorted = useMemo(() => {
    const column = columns.find((c) => c.key === sort?.key);
    if (!sort || !column?.sortValue) return rows;
    const { sortValue } = column;
    const collator = nameCollator(locale);
    const sign = sort.direction === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => sign * compare(sortValue(a), sortValue(b), collator));
  }, [rows, columns, sort, locale]);

  const toggleSort = (key: string) =>
    setSort((current) =>
      current?.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: "asc" },
    );

  const hidden = (column: Column<Row>) => (column.hideOnMobile ? "hidden md:table-cell" : "");

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <table className="typography-table w-full border-collapse text-left">
        <thead className="sticky top-0 z-10 bg-surface-muted text-text-muted">
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                aria-sort={
                  sort?.key === column.key
                    ? sort.direction === "asc"
                      ? "ascending"
                      : "descending"
                    : undefined
                }
                className={`h-[var(--size-row)] border-b border-border px-[var(--space-cell-x)] font-semibold ${column.numeric ? "text-right" : ""} ${hidden(column)} ${column.className ?? ""}`}
              >
                {column.sortValue ? (
                  <button
                    type="button"
                    aria-label={t("table.sortBy", { column: column.header })}
                    onClick={() => toggleSort(column.key)}
                    className="inline-flex items-center gap-[var(--space-tight)] hover:text-text"
                  >
                    {column.header}
                    <span aria-hidden="true" className="text-text-subtle">
                      {sort?.key === column.key ? (sort.direction === "asc" ? "▲" : "▼") : ""}
                    </span>
                  </button>
                ) : (
                  column.header
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody aria-busy={loading || undefined}>
          {loading
            ? Array.from({ length: loadingRows }, (_, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 仮の行は並びが変わらない
                <tr key={index}>
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      className={`h-[var(--size-row)] border-b border-border px-[var(--space-cell-x)] ${hidden(column)}`}
                    >
                      <div className="h-[var(--space-stack-gap)] w-3/4 animate-pulse rounded-[var(--radius-control)] bg-skeleton" />
                    </td>
                  ))}
                </tr>
              ))
            : sorted.map((row) => {
                const key = rowKey(row);
                const href = openHref?.(row) ?? null;
                return (
                  <tr
                    key={key}
                    aria-selected={onRowClick ? key === selectedKey : undefined}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    className={`group border-b border-border ${onRowClick ? "cursor-pointer" : ""} ${
                      key === selectedKey
                        ? "bg-selected outline outline-selected-border -outline-offset-1"
                        : "hover:bg-row-hover"
                    }`}
                  >
                    {columns.map((column, index) => (
                      <td
                        key={column.key}
                        className={`h-[var(--size-row)] px-[var(--space-cell-x)] ${column.numeric ? "typography-numeric text-right" : ""} ${hidden(column)} ${column.className ?? ""}`}
                      >
                        <div className="flex items-center gap-[var(--space-inline-gap)]">
                          <div className="min-w-0 flex-1">{column.cell(row)}</div>
                          {index === columns.length - 1 && href && (
                            <a
                              href={href}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(event) => event.stopPropagation()}
                              className="typography-caption shrink-0 rounded-[var(--radius-control)] px-[var(--space-tight)] text-link opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100"
                            >
                              {t("table.open")} ↗
                            </a>
                          )}
                        </div>
                      </td>
                    ))}
                  </tr>
                );
              })}
        </tbody>
      </table>
      {!loading && rows.length === 0 && empty && (
        <p className="typography-body p-[var(--space-panel-padding)] text-center text-text-muted">
          {empty}
        </p>
      )}
    </div>
  );
}
