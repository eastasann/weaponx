import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { LIMITS } from "@weaponx/shared";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { DataTable } from "../../components/DataTable";
import { KindIcon } from "../../components/KindIcon";
import { LoadError } from "../../components/LoadError";
import { ListPage } from "../../components/layouts";
import { TextField } from "../../components/TextField";
import { useNotify, useNotifyError } from "../../components/Toast";
import { client, unwrap } from "../../lib/api";
import { toApiError } from "../../lib/errors";
import { formatDate } from "../../lib/format";
import { type ProjectRow, projectsQuery, type SearchResult, searchQuery } from "../../lib/queries";
import { SEARCH_DEBOUNCE_MS } from "../../lib/use-debounced-value";
import { useLocale } from "../../lib/use-locale";
import { useIsMobile } from "../../lib/use-media-query";
import { NameDialog } from "../project/NameDialog";

const route = getRouteApi("/_app/");

/** ホーム U1(design-spec 6.4)。案件一覧と横断検索 */
export function HomePage() {
  const { t } = useTranslation();
  const { q = "" } = route.useSearch();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [input, setInput] = useState(q);
  const [creating, setCreating] = useState(false);

  // 入力が止まってから ?q= に反映する。URL 側の変更(戻る・進む)は入力欄に反映する。
  // 自分が反映した値を覚えておき、URL の変更を入力欄に戻す処理と反映の処理が互いを打ち消さないようにする
  const pushed = useRef(q);
  useEffect(() => {
    const value = input.trim();
    if (value === pushed.current) return;
    const timer = setTimeout(() => {
      pushed.current = value;
      void navigate({ to: "/", search: value ? { q: value } : {}, replace: true });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input, navigate]);
  useEffect(() => {
    if (q === pushed.current) return;
    pushed.current = q;
    setInput(q);
  }, [q]);

  const searching = q !== "";

  return (
    <ListPage
      title={t("home.title")}
      toolbar={
        <>
          <div className="relative flex-1">
            <TextField
              type="search"
              hideLabel
              label={t("home.searchLabel")}
              placeholder={`🔍 ${t("home.searchPlaceholder")}`}
              value={input}
              maxLength={LIMITS.searchQuery}
              onChange={(event) => setInput(event.target.value)}
              className="w-full pr-[var(--size-control)] [&::-webkit-search-cancel-button]:hidden"
            />
            {input !== "" && (
              <button
                type="button"
                aria-label={t("home.clearSearch")}
                onClick={() => setInput("")}
                className="absolute top-0 right-0 flex h-[var(--size-control)] w-[var(--size-control)] items-center justify-center text-text-muted hover:text-text"
              >
                ×
              </button>
            )}
          </div>
          {!isMobile && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              {t("home.createProject")}
            </Button>
          )}
        </>
      }
    >
      {searching ? <SearchResults q={q} /> : <ProjectList onCreate={() => setCreating(true)} />}
      {creating && <CreateProjectDialog onClose={() => setCreating(false)} />}
    </ListPage>
  );
}

function ProjectList({ onCreate }: { onCreate: () => void }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const query = useQuery(projectsQuery);

  if (query.isError) return <LoadError onReload={() => void query.refetch()} />;
  const rows = query.data?.projects ?? [];
  if (!query.isPending && rows.length === 0) {
    return (
      <div className="flex flex-col items-center gap-[var(--space-stack-gap)] p-[var(--space-section-gap)] text-center">
        <p className="typography-section-heading">{t("home.emptyTitle")}</p>
        {!isMobile && (
          <Button variant="primary" onClick={onCreate}>
            {t("home.createProject")}
          </Button>
        )}
        <p className="typography-body text-text-muted">{t("home.emptyHint")}</p>
      </div>
    );
  }

  return (
    <DataTable<ProjectRow>
      loading={query.isPending}
      loadingRows={5}
      rows={rows}
      rowKey={(row) => row.id}
      initialSort={{ key: "lastActivity", direction: "desc" }}
      onRowClick={(row) =>
        void navigate({ to: "/projects/$projectId", params: { projectId: row.id } })
      }
      columns={[
        {
          key: "name",
          header: t("home.columns.name"),
          sortValue: (row) => row.name,
          cell: (row) => (
            <Link
              to="/projects/$projectId"
              params={{ projectId: row.id }}
              onClick={(event) => event.stopPropagation()}
              className="block truncate text-text"
            >
              {row.name}
            </Link>
          ),
        },
        {
          key: "role",
          header: t("home.columns.role"),
          hideOnMobile: true,
          cell: (row) => t(`roles.${row.myRole}`),
        },
        {
          key: "documentCount",
          header: t("home.columns.documentCount"),
          hideOnMobile: true,
          numeric: true,
          sortValue: (row) => row.documentCount,
          cell: (row) => row.documentCount,
        },
        {
          key: "lastActivity",
          header: t("home.columns.lastActivity"),
          sortValue: (row) => Date.parse(row.lastActivityAt),
          cell: (row) => formatDate(row.lastActivityAt, locale),
        },
      ]}
    />
  );
}

function SearchResults({ q }: { q: string }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const navigate = useNavigate();
  const query = useQuery(searchQuery(q));

  if (query.isError) return <LoadError onReload={() => void query.refetch()} />;
  const results = query.data?.results ?? [];

  return (
    <>
      {query.data && (
        <p className="typography-section-heading px-[var(--space-page-gutter)] py-[var(--space-inline-gap)]">
          {results.length === 0
            ? t("home.noResults", { q })
            : t("home.resultsHeading", { q, count: results.length })}
        </p>
      )}
      {(query.isPending || results.length > 0) && (
        <DataTable<SearchResult>
          loading={query.isPending}
          loadingRows={3}
          rows={results}
          rowKey={(row) => row.documentId}
          initialSort={{ key: "updated", direction: "desc" }}
          openHref={(row) => row.url}
          onRowClick={(row) =>
            void navigate({
              to: "/projects/$projectId",
              params: { projectId: row.projectId },
              search: { series: row.seriesId, doc: row.documentId },
            })
          }
          columns={[
            {
              key: "name",
              header: t("home.columns.document"),
              sortValue: (row) => row.name,
              cell: (row) => (
                <span className="flex items-center gap-[var(--space-inline-gap)]">
                  <KindIcon kind={row.kind} />
                  <span className="truncate">{row.name}</span>
                  {!row.isLatest && <Badge>{t("home.olderBadge")}</Badge>}
                </span>
              ),
            },
            {
              key: "project",
              header: t("home.columns.project"),
              hideOnMobile: true,
              sortValue: (row) => row.projectName,
              cell: (row) => row.projectName,
            },
            {
              key: "kind",
              header: t("home.columns.kind"),
              hideOnMobile: true,
              cell: (row) => t(`kinds.${row.kind}`),
            },
            {
              key: "updated",
              header: t("home.columns.updated"),
              sortValue: (row) => Date.parse(row.modifiedAt),
              cell: (row) => formatDate(row.modifiedAt, locale),
            },
          ]}
        />
      )}
      {query.data?.truncated && (
        <p className="typography-body p-[var(--space-panel-padding)] text-text-muted">
          {t("home.truncated")}
        </p>
      )}
    </>
  );
}

function CreateProjectDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const notify = useNotify();
  const notifyError = useNotifyError();
  const create = useMutation({
    mutationFn: (name: string) => unwrap(client.api.projects.post({ name })),
    onSuccess: async ({ project }) => {
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      notify({ kind: "success", message: t("createProject.created") });
      void navigate({ to: "/projects/$projectId", params: { projectId: project.id } });
    },
  });

  return (
    <NameDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("createProject.title")}
      submitLabel={t("createProject.submit")}
      pending={create.isPending}
      onSubmit={async (name) => {
        try {
          await create.mutateAsync(name);
        } catch (error) {
          // 検証エラーは欄の下に出す(NameDialog)。それ以外は通知で出し、入力は保つ
          if (toApiError(error).code !== "VALIDATION_FAILED") notifyError(error);
          throw error;
        }
      }}
    />
  );
}
