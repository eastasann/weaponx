import { createFileRoute } from "@tanstack/react-router";

/** 利用者管理 A1(02-01 4章)。画面の中身は Step 10 */
export const Route = createFileRoute("/_app/admin/users")({
  component: () => <main className="flex-1" />,
});
