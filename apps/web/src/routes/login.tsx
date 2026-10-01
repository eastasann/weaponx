import { createFileRoute, redirect } from "@tanstack/react-router";
import { isSafeReturnTo, safeReturnTo } from "@weaponx/shared";
import { LoginPage } from "../features/login/LoginPage";
import { toApiError } from "../lib/errors";
import { configQuery, meQuery } from "../lib/queries";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { returnTo?: string } =>
    typeof search.returnTo === "string" && isSafeReturnTo(search.returnTo)
      ? { returnTo: search.returnTo }
      : {},
  beforeLoad: async ({ context, search }) => {
    // ログイン済みで開いたらホーム(または元の URL)へ移る(design-spec 6.5.1)
    try {
      await context.queryClient.fetchQuery({ ...meQuery, staleTime: 0 });
    } catch (error) {
      const { code } = toApiError(error);
      if (code !== "UNAUTHENTICATED" && code !== "ACCOUNT_SUSPENDED") throw error;
      return;
    }
    throw redirect({ href: safeReturnTo(search.returnTo) });
  },
  loader: ({ context }) => context.queryClient.prefetchQuery(configQuery),
  component: Login,
});

function Login() {
  const { returnTo } = Route.useSearch();
  return <LoginPage returnTo={returnTo} />;
}
