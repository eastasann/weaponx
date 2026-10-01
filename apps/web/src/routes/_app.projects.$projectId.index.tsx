import { createFileRoute } from "@tanstack/react-router";

/** 案件 U2(02-01 4章)。選んだ系列と版は `?series=&doc=`。画面の中身は Step 8 */
export const Route = createFileRoute("/_app/projects/$projectId/")({
  validateSearch: (search: Record<string, unknown>): { series?: string; doc?: string } => ({
    ...(typeof search.series === "string" ? { series: search.series } : {}),
    ...(typeof search.doc === "string" ? { doc: search.doc } : {}),
  }),
  component: () => <main className="flex-1" />,
});
