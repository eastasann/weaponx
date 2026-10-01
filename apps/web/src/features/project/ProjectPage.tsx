import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { LIMITS } from "@weaponx/shared";
import { DropdownMenu } from "radix-ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { DataTable } from "../../components/DataTable";
import { ConfirmDialog } from "../../components/Dialog";
import { KindIcon } from "../../components/KindIcon";
import { LoadError } from "../../components/LoadError";
import { ListWithPanel } from "../../components/layouts";
import { TextField } from "../../components/TextField";
import { useNotify, useNotifyError } from "../../components/Toast";
import { client, unwrap } from "../../lib/api";
import { describeError, toApiError } from "../../lib/errors";
import { formatDate } from "../../lib/format";
import {
  meQuery,
  type ProjectDetail,
  projectQuery,
  type SeriesRow,
  seriesListQuery,
} from "../../lib/queries";
import { useDebouncedValue } from "../../lib/use-debounced-value";
import { useLocale } from "../../lib/use-locale";
import { useIsMobile } from "../../lib/use-media-query";
import { AddDocumentDialog, type AddDocumentPrefill } from "../documents/AddDocumentDialog";
import { CopyDialog, type CopySource } from "../documents/CopyDialog";
import { DeleteVersionDialog } from "../documents/DeleteVersionDialog";
import { EditDocumentDialog } from "../documents/EditDocumentDialog";
import {
  RegisterVersionDialog,
  type RegisterVersionPrefill,
} from "../documents/RegisterVersionDialog";
import { NameDialog } from "./NameDialog";
import { ProjectNotFound } from "./ProjectNotFound";
import { SidePanel } from "./SidePanel";
import { filterSeries, type KindFilter } from "./series-view";
import { TagBadges } from "./TagBadges";

const route = getRouteApi("/_app/projects/$projectId/");

const KINDS = ["google_doc", "google_slides", "google_sheets", "pdf", "other"] as const;

/** 案件 U2(design-spec 6.1)。表と横パネル、案件の名前の変更と削除 */
export function ProjectPage() {
  const { projectId } = route.useParams();
  const project = useQuery(projectQuery(projectId));
  const series = useQuery(seriesListQuery(projectId));

  // 案件が無い・参加していない・削除済みは区別せず、画面全体を「見つからない」にする(design-spec 6.1)
  const gone = [project.error, series.error].some(
    (error) => error && toApiError(error).code === "PROJECT_NOT_FOUND",
  );
  if (gone) return <ProjectNotFound />;
  if (project.isError) return <LoadError onReload={() => void project.refetch()} />;

  return <ProjectView projectId={projectId} project={project.data} />;
}

function ProjectView({
  projectId,
  project,
}: {
  projectId: string;
  project: ProjectDetail | undefined;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const navigate = useNavigate();
  const notify = useNotify();
  const isMobile = useIsMobile();
  const { series: seriesId, doc: documentId } = route.useSearch();
  const seriesQuery = useQuery(seriesListQuery(projectId));
  const queryClient = useQueryClient();
  const { data: me } = useQuery(meQuery);

  const [filterInput, setFilterInput] = useState("");
  const filter = useDebouncedValue(filterInput);
  const [kind, setKind] = useState<KindFilter>("all");
  const [scrollToVersions, setScrollToVersions] = useState(false);
  type DialogState =
    | { type: "add"; prefill?: AddDocumentPrefill }
    | { type: "copy" | "newVersion"; source: CopySource }
    | { type: "registerVersion"; prefill?: RegisterVersionPrefill }
    | { type: "edit"; documentId: string }
    | { type: "delete"; version: { id: string; name: string; versionNo: number } };
  const [dialog, setDialog] = useState<DialogState | null>(null);

  const rows = seriesQuery.data?.series;
  const filtered = useMemo(
    () => (rows ? filterSeries(rows, filter, kind) : []),
    [rows, filter, kind],
  );
  const selectedRow = rows?.find((row) => row.id === seriesId);

  const select = useCallback(
    (search: { series?: string; doc?: string }, options?: { replace?: boolean }) => {
      setScrollToVersions(false);
      void navigate({ to: "/projects/$projectId", params: { projectId }, search, ...options });
    },
    [navigate, projectId],
  );
  const closePanel = useCallback(() => select({}), [select]);

  const openCopy = (kind: "newVersion" | "copy", version: CopySource & { id?: string }) =>
    setDialog({ type: kind, source: version });

  const afterCopy = (
    mode: "copy" | "newVersion",
    result: {
      projectId: string;
      projectName: string;
      seriesId: string;
      documentId: string;
      editUrl: string;
    },
  ) => {
    const editor = { label: t("addDocument.openEditor"), href: result.editUrl };
    if (mode === "newVersion") {
      select({ series: result.seriesId, doc: result.documentId });
      notify({ kind: "success", message: t("copyDialog.versionCreated"), actions: [editor] });
    } else if (result.projectId === projectId) {
      select({ series: result.seriesId, doc: result.documentId });
      notify({ kind: "success", message: t("addDocument.created"), actions: [editor] });
    } else {
      notify({
        kind: "success",
        message: t("copyDialog.createdIn", { project: result.projectName }),
        actions: [
          {
            label: t("copyDialog.openCreated"),
            onClick: () =>
              void navigate({
                to: "/projects/$projectId",
                params: { projectId: result.projectId },
                search: { series: result.seriesId, doc: result.documentId },
              }),
          },
          editor,
        ],
      });
    }
  };

  const afterDelete = async (result: { seriesRemoved: boolean; latestId: string | null }) => {
    // 先に表示を移す。削除した版を表示したまま取り直すと、パネルが「見つからない」になる
    if (result.seriesRemoved || !seriesId || !result.latestId) {
      closePanel();
      notify({ kind: "success", message: t("deleteVersion.seriesDeleted") });
    } else {
      select({ series: seriesId, doc: result.latestId }, { replace: true });
      notify({ kind: "success", message: t("deleteVersion.deleted") });
    }
    await queryClient.invalidateQueries({ queryKey: ["projects"] });
    await queryClient.invalidateQueries({ queryKey: ["series"] });
  };

  // URL で指定された系列が無い・削除済みなら、横パネルは開かず表だけを出して知らせる(design-spec 6.1)
  // 取り直している間の表は古いかもしれない(別の案件から移ってきたときなど)ので、取り直しが終わってから判定する
  const missing =
    seriesId !== undefined && rows !== undefined && !seriesQuery.isFetching && !selectedRow;
  useEffect(() => {
    if (!missing) return;
    notify({ kind: "error", message: t("errors.DOCUMENT_NOT_FOUND") });
    void navigate({ to: "/projects/$projectId", params: { projectId }, search: {}, replace: true });
  }, [missing, notify, t, navigate, projectId]);

  // 横パネルの詳細が見つからないとき(design-spec 6.0.2・6.1)。パネルを表示した後に版が削除されたなら、
  // 表を読み込み直し、系列が残っていれば最新版に切り替える。開いた時点で URL が古かったなら、パネルを開かずに知らせる
  const handleMissing = useCallback(
    async (wasLoaded: boolean) => {
      if (wasLoaded && seriesId) {
        try {
          const fresh = await queryClient.fetchQuery({
            ...seriesListQuery(projectId),
            staleTime: 0,
          });
          const row = fresh.series.find((candidate) => candidate.id === seriesId);
          if (row) select({ series: row.id, doc: row.latest.id }, { replace: true });
          // 系列そのものが無くなっていれば、表を読み直した結果を受けて上の「URL の系列が無い」処理が通知して閉じる
          return;
        } catch {
          // 表を読み直せないときは、パネルを閉じて知らせる
        }
      }
      notify({ kind: "error", message: t("errors.DOCUMENT_NOT_FOUND") });
      select({}, { replace: true });
    },
    [seriesId, queryClient, projectId, select, notify, t],
  );

  // Esc で横パネルを閉じる。ダイアログやメニューが開いている間は、そちらの Esc に任せる
  useEffect(() => {
    if (!selectedRow) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      closePanel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selectedRow, closePanel]);

  // 表を出した後にメタデータを取り直す。連携中の人が、案件を開いたときに1回だけ(design-spec 6.1)
  const refreshed = useRef<string | null>(null);
  const refresh = useMutation({
    mutationFn: () => unwrap(client.api.projects({ projectId })["metadata-refresh"].post()),
    onSuccess: async ({ updatedSeriesIds }) => {
      if (updatedSeriesIds.length === 0) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["projects", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["series"] }),
      ]);
    },
    // 失敗しても何も出さず、保存済みの値を使う。認可エラーの要再連携への切り替えは全体の処理が行う
    onError: () => {},
  });
  const { mutate: refreshMetadata } = refresh;
  const driveActive = me?.drive.status === "active";
  useEffect(() => {
    if (!rows || !driveActive || refreshed.current === projectId) return;
    refreshed.current = projectId;
    refreshMetadata();
  }, [rows, driveActive, projectId, refreshMetadata]);

  const panelOpen = selectedRow !== undefined;
  const proj = project?.project;
  const role = proj?.myRole;
  const canManage = role === "owner" && !isMobile;
  // 編集者以上・デスクトップとタブレットだけに、変更の操作を出す(design-spec 6.1)
  const canEdit = role !== undefined && role !== "viewer" && !isMobile;

  const columns = [
    {
      key: "name",
      header: t("project.columns.name"),
      sortValue: (row: SeriesRow) => row.latest.name,
      cell: (row: SeriesRow) => (
        <span className="flex min-w-0 items-center gap-[var(--space-inline-gap)]">
          <KindIcon kind={row.latest.kind} />
          <span className="min-w-0 truncate">{row.latest.name}</span>
          {!isMobile && <TagBadges tags={row.tags} limit={panelOpen ? 1 : 2} />}
          {!isMobile && row.olderCount > 0 && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                select({ series: row.id, doc: row.latest.id });
                setScrollToVersions(true);
              }}
              className="shrink-0 rounded-[var(--radius-chip)]"
            >
              <Badge>{t("project.olderVersions", { count: row.olderCount })}</Badge>
            </button>
          )}
        </span>
      ),
    },
    {
      key: "kind",
      header: t("project.columns.kind"),
      hideOnMobile: true,
      cell: (row: SeriesRow) => t(`kinds.${row.latest.kind}`),
    },
    {
      key: "updated",
      header: t("project.columns.updated"),
      sortValue: (row: SeriesRow) => Date.parse(row.latest.modifiedAt),
      cell: (row: SeriesRow) => formatDate(row.latest.modifiedAt, locale),
    },
    {
      key: "registeredBy",
      header: t("project.columns.registeredBy"),
      hideOnMobile: true,
      cell: (row: SeriesRow) =>
        row.latest.registeredBy.displayName ?? row.latest.registeredBy.email,
    },
  ];
  // 横パネルが開いている間は、表を資料名と更新の2列にする
  const visibleColumns = panelOpen
    ? columns.filter((column) => column.key === "name" || column.key === "updated")
    : columns;

  const clearFilters = () => {
    setFilterInput("");
    setKind("all");
  };

  let list: React.ReactNode;
  if (seriesQuery.isError) {
    list = (
      <LoadError message={t("project.loadFailed")} onReload={() => void seriesQuery.refetch()} />
    );
  } else if (rows && rows.length === 0) {
    list = canEdit ? (
      <div className="flex flex-col items-center gap-[var(--space-stack-gap)] p-[var(--space-section-gap)] text-center">
        <p className="typography-section-heading">{t("project.emptyTitle")}</p>
        <Button variant="primary" onClick={() => setDialog({ type: "add" })}>
          {t("project.addDocument")}
        </Button>
        <p className="typography-body text-text-muted">{t("project.emptyHint")}</p>
      </div>
    ) : (
      <p className="typography-body p-[var(--space-section-gap)] text-center text-text-muted">
        {t("project.emptyViewer")}
      </p>
    );
  } else if (rows && filtered.length === 0) {
    list = (
      <div className="flex flex-col items-center gap-[var(--space-stack-gap)] p-[var(--space-section-gap)] text-center">
        <p className="typography-body text-text-muted">{t("project.filteredEmpty")}</p>
        <Button onClick={clearFilters}>{t("project.clearFilters")}</Button>
      </div>
    );
  } else {
    list = (
      <DataTable<SeriesRow>
        loading={seriesQuery.isPending}
        loadingRows={8}
        rows={filtered}
        rowKey={(row) => row.id}
        selectedKey={selectedRow?.id ?? null}
        initialSort={{ key: "updated", direction: "desc" }}
        openHref={(row) => row.latest.url}
        onRowClick={(row) => select({ series: row.id, doc: row.latest.id })}
        columns={visibleColumns}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-[var(--size-toolbar)] items-center gap-[var(--space-inline-gap)] border-b border-border px-[var(--space-page-gutter)]">
        <Link to="/" className="typography-label shrink-0 text-link">
          {t("project.back")}
        </Link>
        <h1 className="typography-page-title min-w-0 truncate">{proj?.name}</h1>
        {role && <Badge>{t(`roles.${role}`)}</Badge>}
        <span className="flex-1" />
        {!isMobile && proj && (
          <Link
            to="/projects/$projectId/members"
            params={{ projectId }}
            className="typography-label inline-flex h-[var(--size-control)] items-center rounded-[var(--radius-control)] border border-border-strong px-[var(--space-stack-gap)] hover:bg-row-hover"
          >
            {t("project.members", { count: proj.memberCount })}
          </Link>
        )}
        {canEdit && (
          <Button variant="primary" onClick={() => setDialog({ type: "add" })}>
            {t("project.addDocument")}
          </Button>
        )}
        {canManage && proj && <ProjectMenu projectId={projectId} name={proj.name} />}
      </div>
      <ListWithPanel
        toolbar={
          <>
            <TextField
              type="search"
              hideLabel
              label={t("project.filterLabel")}
              placeholder={t("project.filterPlaceholder")}
              value={filterInput}
              maxLength={LIMITS.searchQuery}
              onChange={(event) => setFilterInput(event.target.value)}
              className="w-64 max-w-full"
            />
            <label className="typography-body flex items-center gap-[var(--space-inline-gap)]">
              {t("project.kindLabel")}
              <select
                value={kind}
                onChange={(event) => setKind(event.target.value as KindFilter)}
                className="typography-body h-[var(--size-control)] rounded-[var(--radius-control)] border border-border-strong bg-surface px-[var(--space-inline-gap)]"
              >
                <option value="all">{t("project.kindAll")}</option>
                {KINDS.map((value) => (
                  <option key={value} value={value}>
                    {t(`kinds.${value}`)}
                  </option>
                ))}
              </select>
            </label>
            <span className="flex-1" />
            {rows && (
              <span className="typography-body text-text-muted">
                {t("project.count", { count: filtered.length })}
              </span>
            )}
          </>
        }
        list={list}
        panel={
          panelOpen && selectedRow ? (
            <SidePanel
              projectId={projectId}
              row={selectedRow}
              documentId={documentId}
              onClose={closePanel}
              onMissing={(wasLoaded) => void handleMissing(wasLoaded)}
              canEdit={canEdit}
              onAction={(action, version) => {
                if (action === "delete") {
                  setDialog({
                    type: "delete",
                    version: { id: version.id, name: version.name, versionNo: version.versionNo },
                  });
                } else if (action === "registerVersion") {
                  setDialog({ type: "registerVersion" });
                } else if (action === "edit") {
                  setDialog({ type: "edit", documentId: version.id });
                } else {
                  openCopy(action, {
                    documentId: version.id,
                    name: version.name,
                    kind: version.kind,
                    versionNo: version.versionNo,
                  });
                }
              }}
              scrollToVersions={scrollToVersions}
              onScrolled={() => setScrollToVersions(false)}
            />
          ) : null
        }
      />
      {dialog?.type === "add" && (
        <AddDocumentDialog
          key={dialog.prefill?.url ?? "new"}
          projectId={projectId}
          {...(dialog.prefill ? { prefill: dialog.prefill } : {})}
          onClose={() => setDialog(null)}
          onSelect={(target) => select({ series: target.seriesId, doc: target.documentId })}
        />
      )}
      {(dialog?.type === "copy" || dialog?.type === "newVersion") && selectedRow && (
        <CopyDialog
          mode={dialog.type}
          projectId={projectId}
          projectName={proj?.name ?? ""}
          seriesId={selectedRow.id}
          source={dialog.source}
          onClose={() => setDialog(null)}
          onCreated={(result) => afterCopy(dialog.type as "copy" | "newVersion", result)}
          onRegisterByLink={(failure, name, changeNote) =>
            dialog.type === "newVersion"
              ? setDialog({
                  type: "registerVersion",
                  prefill: { url: failure.url, name, changeNote },
                })
              : setDialog({
                  type: "add",
                  prefill: {
                    url: failure.url,
                    name,
                    references: [
                      {
                        key: dialog.source.documentId,
                        visibility: "visible",
                        documentId: dialog.source.documentId,
                        name: dialog.source.name,
                        kind: dialog.source.kind,
                        projectName: null,
                      },
                    ],
                  },
                })
          }
        />
      )}
      {dialog?.type === "registerVersion" && selectedRow && (
        <RegisterVersionDialog
          key={dialog.prefill?.url ?? "new"}
          projectId={projectId}
          seriesId={selectedRow.id}
          {...(dialog.prefill ? { prefill: dialog.prefill } : {})}
          onClose={() => setDialog(null)}
          onSelect={(target) => select({ series: target.seriesId, doc: target.documentId })}
        />
      )}
      {dialog?.type === "edit" && selectedRow && (
        <EditDocumentDialog
          projectId={projectId}
          seriesId={selectedRow.id}
          documentId={dialog.documentId}
          onClose={() => setDialog(null)}
          onSelect={(target) => select({ series: target.seriesId, doc: target.documentId })}
        />
      )}
      {dialog?.type === "delete" && (
        <DeleteVersionDialog
          version={dialog.version}
          onClose={() => setDialog(null)}
          onDeleted={(result) => void afterDelete(result)}
        />
      )}
    </div>
  );
}

function ProjectMenu({ projectId, name }: { projectId: string; name: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const notify = useNotify();
  const notifyError = useNotifyError();
  const [dialog, setDialog] = useState<"rename" | "delete" | null>(null);

  // 権限が変わった・案件が無くなった場合はダイアログを閉じ、画面を読み込み直して新しい状態にする(design-spec 6.0.2)
  const afterFailure = async (error: unknown) => {
    const { category } = describeError(error);
    if (category === "not_found" || category === "forbidden") {
      setDialog(null);
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
    }
    if (category !== "not_found" && category !== "input") notifyError(error);
  };

  const rename = useMutation({
    mutationFn: (next: string) => unwrap(client.api.projects({ projectId }).patch({ name: next })),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      setDialog(null);
      notify({ kind: "success", message: t("project.renamed") });
    },
  });
  const remove = useMutation({
    mutationFn: () => unwrap(client.api.projects({ projectId }).delete()),
    onSuccess: async () => {
      setDialog(null);
      await navigate({ to: "/" });
      queryClient.removeQueries({ queryKey: ["projects", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      notify({ kind: "success", message: t("project.deleted") });
    },
    onError: afterFailure,
  });

  const ITEM =
    "typography-body flex min-h-[var(--size-control)] cursor-pointer items-center rounded-[var(--radius-control)] px-[var(--space-inline-gap)] outline-none data-[highlighted]:bg-row-hover";

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          aria-label={t("project.menu")}
          className="typography-label h-[var(--size-control)] w-[var(--size-control)] rounded-[var(--radius-control)] hover:bg-row-hover focus-visible:outline-2 focus-visible:outline-focus-ring"
        >
          ⋯
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={4}
            className="z-30 rounded-[var(--radius-surface)] border border-border bg-surface p-[var(--space-tight)] text-text shadow-[var(--shadow-popover)]"
          >
            <DropdownMenu.Item className={ITEM} onSelect={() => setDialog("rename")}>
              {t("project.rename")}
            </DropdownMenu.Item>
            <DropdownMenu.Item className={ITEM} onSelect={() => setDialog("delete")}>
              {t("project.delete")}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {dialog === "rename" && (
        <NameDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          title={t("project.renameTitle")}
          submitLabel={t("project.renameSubmit")}
          initialValue={name}
          pending={rename.isPending}
          onSubmit={async (next) => {
            try {
              await rename.mutateAsync(next);
            } catch (error) {
              if (toApiError(error).code !== "VALIDATION_FAILED") await afterFailure(error);
              throw error;
            }
          }}
        />
      )}
      <ConfirmDialog
        open={dialog === "delete"}
        onOpenChange={(open) => !open && setDialog(null)}
        title={t("project.deleteTitle")}
        message={t("project.deleteMessage", { name })}
        confirmLabel={t("project.deleteConfirm")}
        destructive
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </>
  );
}
