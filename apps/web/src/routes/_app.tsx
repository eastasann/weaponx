import { createFileRoute, redirect } from "@tanstack/react-router";
import { isSafeReturnTo } from "@weaponx/shared";
import { AppLayout } from "../features/layout/AppLayout";
import { toApiError } from "../lib/errors";
import { meQuery } from "../lib/queries";

/** 認証の要る画面の入口。未ログインなら `/login?returnTo=` へ送る(02-01 4章、design-spec 6.0.7) */
export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context, location }) => {
    try {
      await context.queryClient.ensureQueryData(meQuery);
    } catch (error) {
      const { code } = toApiError(error);
      const returnTo = location.pathname + location.searchStr;
      if (code === "UNAUTHENTICATED") {
        throw redirect({ to: "/login", search: isSafeReturnTo(returnTo) ? { returnTo } : {} });
      }
      // 停止の表示はサーバーが置く Cookie でログイン画面が出す(design-spec 6.0.2)
      if (code === "ACCOUNT_SUSPENDED") throw redirect({ to: "/login", search: {} });
      throw error;
    }
  },
  component: AppLayout,
});
