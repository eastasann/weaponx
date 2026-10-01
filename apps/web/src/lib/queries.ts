import { queryOptions } from "@tanstack/react-query";
import { client, unwrap } from "./api";

/**
 * セッションの有無の判定とヘッダーの表示に使う。401 を再試行しない。
 * 未ログインの判定そのものなので、失敗してもログイン画面へは送らない(送り先は呼び出し側が決める)。
 */
export const meQuery = queryOptions({
  queryKey: ["me"],
  meta: { probesSession: true },
  queryFn: () => unwrap(client.api.me.get()),
  retry: false,
  staleTime: Number.POSITIVE_INFINITY,
});

export const configQuery = queryOptions({
  queryKey: ["config"],
  queryFn: () => unwrap(client.api.config.get()),
  retry: false,
  staleTime: Number.POSITIVE_INFINITY,
});

export type Me = Awaited<ReturnType<NonNullable<typeof meQuery.queryFn>>>;

const fetchProjects = () => unwrap(client.api.projects.get({ query: {} }));
const fetchSeriesList = (projectId: string) =>
  unwrap(client.api.projects({ projectId }).series.get());
const fetchSeriesDetail = (seriesId: string, documentId: string | undefined) =>
  unwrap(client.api.series({ seriesId }).get({ query: documentId ? { documentId } : {} }));
const fetchSearch = (q: string) => unwrap(client.api.search.get({ query: { q } }));

const fetchProject = (projectId: string) => unwrap(client.api.projects({ projectId }).get());
export type ProjectDetail = Awaited<ReturnType<typeof fetchProject>>;
export type ProjectRow = Awaited<ReturnType<typeof fetchProjects>>["projects"][number];
export type SeriesRow = Awaited<ReturnType<typeof fetchSeriesList>>["series"][number];
export type SeriesDetail = Awaited<ReturnType<typeof fetchSeriesDetail>>;
export type RelatedItem = SeriesDetail["references"][number];
export type SearchResult = Awaited<ReturnType<typeof fetchSearch>>["results"][number];

export const projectsQuery = queryOptions({ queryKey: ["projects"], queryFn: fetchProjects });

export const projectQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId],
    queryFn: () => fetchProject(projectId),
  });

export const seriesListQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "series"],
    queryFn: () => fetchSeriesList(projectId),
  });

/** 横パネルの中身。`documentId` を省くと最新版 */
export const seriesDetailQuery = (seriesId: string, documentId: string | undefined) =>
  queryOptions({
    queryKey: ["series", seriesId, documentId ?? null],
    queryFn: () => fetchSeriesDetail(seriesId, documentId),
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === seriesId ? previous : undefined,
  });

export const searchQuery = (q: string) =>
  queryOptions({ queryKey: ["search", q], queryFn: () => fetchSearch(q) });
