import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import { useEffect } from "react";
import { ToastProvider } from "../components/Toast";
import { ErrorPage } from "../features/errors/ErrorPage";
import { reportClientError } from "../lib/api";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: () => (
    <ToastProvider>
      <Outlet />
    </ToastProvider>
  ),
  notFoundComponent: () => <ErrorPage kind="notFound" />,
  errorComponent: ({ error }) => <UnexpectedError error={error} />,
});

/** 画面全体を表示できないとき(design-spec 6.5.7)。内容を API に送る(02-01 8章) */
function UnexpectedError({ error }: { error: unknown }) {
  useEffect(() => {
    void reportClientError(error);
  }, [error]);
  return <ErrorPage kind="unexpected" />;
}
