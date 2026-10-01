import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "./features/errors/ErrorBoundary";
import "./lib/i18n";
import { toApiError } from "./lib/errors";
import { handleGlobalError } from "./lib/session-effects";
import { routeTree } from "./routeTree.gen";
import "./styles/index.css";

const onError = (error: unknown) => handleGlobalError(error, queryClient, router);

const queryClient: QueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 通信の失敗と 5xx だけを1回再試行する(02-01 8章)。4xx は再試行しても結果が変わらない
      retry: (failureCount, error) => {
        const { status } = toApiError(error);
        return failureCount < 1 && (status === 0 || status >= 500);
      },
      retryDelay: 500,
    },
  },
  queryCache: new QueryCache({
    onError: (error, query) => {
      if (!query.meta?.probesSession) onError(error);
    },
  }),
  mutationCache: new MutationCache({ onError }),
});

const router = createRouter({ routeTree, context: { queryClient } });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("#root が見つかりません");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary>
        <RouterProvider router={router} />
      </ErrorBoundary>
    </QueryClientProvider>
  </StrictMode>,
);
