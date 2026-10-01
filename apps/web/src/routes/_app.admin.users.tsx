import { createFileRoute } from "@tanstack/react-router";
import { AdminUsersPage } from "../features/admin/AdminUsersPage";

/** 利用者管理 A1(02-01 4章) */
export const Route = createFileRoute("/_app/admin/users")({
  component: AdminUsersPage,
});
