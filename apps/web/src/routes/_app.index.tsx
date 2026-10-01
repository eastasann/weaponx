import { createFileRoute } from "@tanstack/react-router";

/** ホーム U1(02-01 4章)。検索語は `?q=`。画面の中身は Step 8 */
export const Route = createFileRoute("/_app/")({
  validateSearch: (search: Record<string, unknown>): { q?: string } =>
    typeof search.q === "string" && search.q !== "" ? { q: search.q } : {},
  component: () => <main className="flex-1" />,
});
