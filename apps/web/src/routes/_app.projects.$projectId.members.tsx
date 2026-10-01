import { createFileRoute } from "@tanstack/react-router";

/** メンバー管理 U3(02-01 4章)。画面の中身は Step 10 */
export const Route = createFileRoute("/_app/projects/$projectId/members")({
  component: () => <main className="flex-1" />,
});
