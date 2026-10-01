import { createFileRoute } from "@tanstack/react-router";
import { HomePage } from "../features/home/HomePage";

/** ホーム U1(02-01 4章)。検索語は `?q=` */
export const Route = createFileRoute("/_app/")({
  validateSearch: (search: Record<string, unknown>): { q?: string } =>
    typeof search.q === "string" && search.q !== "" ? { q: search.q } : {},
  component: HomePage,
});
