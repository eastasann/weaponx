import { createFileRoute } from "@tanstack/react-router";
import { MembersPage } from "../features/members/MembersPage";

/** メンバー管理 U3(02-01 4章) */
export const Route = createFileRoute("/_app/projects/$projectId/members")({
  component: MembersPage,
});
