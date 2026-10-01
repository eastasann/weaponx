import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { KindIcon } from "../../components/KindIcon";
import { LoadError } from "../../components/LoadError";
import { describeError } from "../../lib/errors";
import { formatDateTime, nameCollator } from "../../lib/format";
import { type RelatedItem, type SeriesRow, seriesDetailQuery } from "../../lib/queries";
import { useLocale } from "../../lib/use-locale";
import { sortRelated } from "./series-view";

type SidePanelProps = {
  projectId: string;
  row: SeriesRow;
  /** URL の ?doc=。無ければ最新版 */
  documentId: string | undefined;
  onClose: () => void;
  /**
   * 詳細が「見つからない」になったときに呼ぶ。`wasLoaded` は、この系列の詳細をいちど表示できていたか
   * (表示した後に版が削除された場合と、開いた時点で URL が古い場合で、画面の動きが違う。design-spec 6.0.2・6.1)
   */
  onMissing: (wasLoaded: boolean) => void;
  /** 編集者以上のデスクトップ・タブレットだけ、操作の欄を出す(design-spec 6.1) */
  canEdit: boolean;
  /** 操作の欄のボタン。ダイアログは呼び出し側が開く */
  onAction: (
    action: "newVersion" | "copy" | "registerVersion" | "edit" | "delete",
    version: SelectedVersion,
  ) => void;
  /** 「旧版 n件」から開いたとき、読み込めたら版の欄までスクロールする */
  scrollToVersions: boolean;
  onScrolled: () => void;
};

/** 操作の対象にする版(選んでいる版。「新しい版を作る」は系列の最新版を使う) */
export type SelectedVersion = SeriesRow["latest"];

/** ドキュメント・スライドで、ドライブのファイルを持つ版だけ、ドライブ上でコピーできる(design-spec 6.1) */
const canCopy = (version: SelectedVersion) =>
  (version.kind === "google_doc" || version.kind === "google_slides") &&
  version.googleFileId !== null;

function userName(user: { displayName: string | null; email: string }) {
  return user.displayName ?? user.email;
}

/** 横パネル(design-spec 6.1)。選んだ系列の、選んだ版を表示する */
export function SidePanel({
  projectId,
  row,
  documentId,
  onClose,
  onMissing,
  canEdit,
  onAction,
  scrollToVersions,
  onScrolled,
}: SidePanelProps) {
  const { t } = useTranslation();
  const locale = useLocale();
  const navigate = useNavigate();
  const query = useQuery(seriesDetailQuery(row.id, documentId));
  const versionsRef = useRef<HTMLElement>(null);

  const detail = query.data;
  // 版を切り替えた直後は前の詳細が残る(placeholderData)。版の一覧は同じ系列なので、見出しと「開く」は
  // 選んだ版のものを先に出し、参考資料の欄だけ読み込み中にする
  const stale = query.isPlaceholderData;
  const selectedId = documentId ?? (stale ? row.latest.id : detail?.selectedDocumentId);
  const selected = detail?.versions.find((version) => version.id === selectedId);
  // 最新版を選んでいる間の読み込み中は、表の行の情報で見出しと「開く」を先に出す
  const head = selected ?? (documentId ? undefined : row.latest);

  const loadedSeries = useRef<string | null>(null);
  useEffect(() => {
    if (detail && !stale) loadedSeries.current = row.id;
  }, [detail, stale, row.id]);
  // 同じエラーで繰り返し呼ばない(親の再描画で onMissing の参照が変わっても、通知と切り替えは1回)
  const error = query.error;
  const handledError = useRef<unknown>(null);
  const onMissingRef = useRef(onMissing);
  onMissingRef.current = onMissing;
  useEffect(() => {
    if (!error || handledError.current === error) return;
    if (describeError(error, "read").category !== "not_found") return;
    handledError.current = error;
    onMissingRef.current(loadedSeries.current === row.id);
  }, [error, row.id]);

  useEffect(() => {
    if (!scrollToVersions || !detail) return;
    versionsRef.current?.scrollIntoView({ block: "start" });
    onScrolled();
  }, [scrollToVersions, detail, onScrolled]);

  const collator = useMemo(() => nameCollator(locale), [locale]);
  const references = useMemo(
    () => sortRelated(detail?.references ?? [], collator),
    [detail?.references, collator],
  );
  const referencedBy = useMemo(
    () => sortRelated(detail?.referencedBy ?? [], collator),
    [detail?.referencedBy, collator],
  );

  const select = (docId: string) =>
    void navigate({
      to: "/projects/$projectId",
      params: { projectId },
      search: { series: row.id, doc: docId },
    });

  const openRelated = (item: Extract<RelatedItem, { visibility: "visible" }>) =>
    void navigate({
      to: "/projects/$projectId",
      params: { projectId: item.projectId },
      search: { series: item.seriesId, doc: item.documentId },
    });

  return (
    <section aria-label={t("panel.label")} className="flex flex-col gap-[var(--space-section-gap)]">
      <div className="flex items-start gap-[var(--space-inline-gap)]">
        <h2 className="typography-section-heading flex min-w-0 flex-1 items-center gap-[var(--space-inline-gap)]">
          {head ? (
            <>
              <KindIcon kind={head.kind} />
              <span className="min-w-0 break-words">{head.name}</span>
            </>
          ) : (
            <span
              aria-hidden="true"
              className="h-[var(--space-section-gap)] w-2/3 animate-pulse rounded-[var(--radius-control)] bg-skeleton"
            />
          )}
        </h2>
        <button
          type="button"
          aria-label={t("panel.close")}
          onClick={onClose}
          className="typography-label h-[var(--size-control)] w-[var(--size-control)] shrink-0 rounded-[var(--radius-control)] text-text-muted hover:bg-row-hover"
        >
          ×
        </button>
      </div>
      {head && (
        <>
          <a
            href={head.url}
            target="_blank"
            rel="noopener noreferrer"
            className="typography-label inline-flex h-[var(--size-control)] w-fit items-center rounded-[var(--radius-control)] border border-border-strong px-[var(--space-stack-gap)] text-link hover:bg-row-hover"
          >
            {t("panel.open")} ↗
          </a>

          <div className="typography-body flex flex-col gap-[var(--space-tight)]">
            <p className="flex flex-wrap items-center gap-[var(--space-inline-gap)]">
              <span>{t(`kinds.${head.kind}`)}</span>
              <span>
                ・{" "}
                {head.isLatest
                  ? t("panel.versionLatest", { n: head.versionNo })
                  : t("panel.versionNo", { n: head.versionNo })}
              </span>
              {head.tags.map((tag) => (
                <Badge key={tag}>{tag}</Badge>
              ))}
            </p>
            <dl className="flex flex-col gap-[var(--space-tight)]">
              <div className="flex gap-[var(--space-inline-gap)]">
                <dt className="text-text-muted">{t("panel.overview.modified")}</dt>
                <dd>{formatDateTime(head.modifiedAt, locale)}</dd>
              </div>
              <div className="flex gap-[var(--space-inline-gap)]">
                <dt className="text-text-muted">{t("panel.overview.registeredBy")}</dt>
                <dd>{userName(head.registeredBy)}</dd>
              </div>
              {head.changeNote && (
                <div className="flex gap-[var(--space-inline-gap)]">
                  <dt className="text-text-muted">{t("panel.overview.changeNote")}</dt>
                  <dd className="min-w-0 break-words">{head.changeNote}</dd>
                </div>
              )}
            </dl>
          </div>
        </>
      )}

      {query.isError ? (
        <LoadError onReload={() => void query.refetch()} />
      ) : (
        <>
          <Section title={t("panel.versions")} sectionRef={versionsRef}>
            {query.isPending ? (
              <Skeleton />
            ) : (
              <ul className="flex flex-col gap-[var(--space-tight)]">
                {detail?.versions.map((version) => (
                  <li key={version.id}>
                    <button
                      type="button"
                      aria-current={version.id === selectedId}
                      onClick={() => select(version.id)}
                      className={`typography-body flex w-full flex-col rounded-[var(--radius-control)] px-[var(--space-inline-gap)] py-[var(--space-tight)] text-left hover:bg-row-hover ${
                        version.id === selectedId ? "bg-selected" : ""
                      }`}
                    >
                      <span className="flex flex-wrap items-center gap-[var(--space-inline-gap)]">
                        <span aria-hidden="true">{version.id === selectedId ? "●" : "○"}</span>
                        <span className="typography-numeric">
                          {t("panel.versionNo", { n: version.versionNo })}
                        </span>
                        <span className="min-w-0 break-words">{version.name}</span>
                        {version.tags.map((tag) => (
                          <Badge key={tag}>{tag}</Badge>
                        ))}
                        <span className="text-text-muted">
                          {formatDateTime(version.modifiedAt, locale)}
                        </span>
                        <span className="text-text-muted">{userName(version.registeredBy)}</span>
                      </span>
                      {version.changeNote && (
                        <span className="typography-caption pl-[var(--space-section-gap)] text-text-muted">
                          {version.changeNote}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title={t("panel.references")}>
            {query.isPending || stale ? (
              <Skeleton />
            ) : (
              <RelatedList items={references} onOpen={openRelated} />
            )}
          </Section>
          <Section title={t("panel.referencedBy")}>
            {query.isPending || stale ? (
              <Skeleton />
            ) : (
              <RelatedList items={referencedBy} onOpen={openRelated} />
            )}
          </Section>
        </>
      )}

      {canEdit && head && (
        <Section title={t("panel.actions")}>
          <div className="flex flex-wrap gap-[var(--space-inline-gap)]">
            {canCopy(row.latest) && (
              <Button variant="primary" onClick={() => onAction("newVersion", row.latest)}>
                {t("panel.newVersion")}
              </Button>
            )}
            {canCopy(head) && (
              <Button onClick={() => onAction("copy", head)}>{t("panel.copy")}</Button>
            )}
            <Button onClick={() => onAction("registerVersion", row.latest)}>
              {t("panel.registerVersion")}
            </Button>
            <Button onClick={() => onAction("edit", head)}>{t("panel.edit")}</Button>
            <Button onClick={() => onAction("delete", head)}>{t("panel.deleteVersion")}</Button>
          </div>
        </Section>
      )}
    </section>
  );
}

function Section({
  title,
  sectionRef,
  children,
}: {
  title: string;
  sectionRef?: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
}) {
  return (
    <section ref={sectionRef} className="flex flex-col gap-[var(--space-inline-gap)]">
      <h3 className="typography-label border-b border-border pb-[var(--space-tight)] text-text-muted">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Skeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-[var(--space-inline-gap)]">
      {[0, 1].map((index) => (
        <div
          key={index}
          className="h-[var(--space-stack-gap)] w-3/4 animate-pulse rounded-[var(--radius-control)] bg-skeleton"
        />
      ))}
    </div>
  );
}

function RelatedList({
  items,
  onOpen,
}: {
  items: RelatedItem[];
  onOpen: (item: Extract<RelatedItem, { visibility: "visible" }>) => void;
}) {
  const { t } = useTranslation();
  if (items.length === 0)
    return <p className="typography-body text-text-muted">{t("panel.none")}</p>;
  return (
    <ul className="flex flex-col gap-[var(--space-tight)]">
      {items.map((item, index) => {
        if (item.visibility === "no_access") {
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: 名前も ID も持たない行(design-spec 6.1 規則1・2)
            <li key={index} className="typography-body text-text-muted">
              <span aria-hidden="true">🔒 </span>
              {t("panel.noAccess")}
            </li>
          );
        }
        if (item.visibility === "deleted") {
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: 名前も ID も持たない行(design-spec 6.1 規則1・2)
            <li key={index} className="typography-body text-text-muted">
              {t("panel.deleted")}
            </li>
          );
        }
        return (
          <li key={item.documentId}>
            <button
              type="button"
              onClick={() => onOpen(item)}
              className="typography-body flex w-full flex-col rounded-[var(--radius-control)] px-[var(--space-inline-gap)] py-[var(--space-tight)] text-left hover:bg-row-hover"
            >
              <span className="flex flex-wrap items-center gap-[var(--space-inline-gap)]">
                <KindIcon kind={item.kind} />
                <span className="min-w-0 break-words">{item.name}</span>
                {item.projectName !== null && (
                  <span className="text-text-muted">
                    {t("panel.projectSuffix", { project: item.projectName })}
                  </span>
                )}
                {!item.isLatest && (
                  <span className="text-text-muted">
                    {t("panel.versionNo", { n: item.versionNo })}
                  </span>
                )}
              </span>
              {item.referencedVersionNo != null && (
                <span className="typography-caption pl-[var(--space-section-gap)] text-text-muted">
                  {t("panel.usesVersion", { n: item.referencedVersionNo })}
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
