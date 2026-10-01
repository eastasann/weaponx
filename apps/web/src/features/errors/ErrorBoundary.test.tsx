import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import i18n from "../../lib/i18n";
import { ErrorBoundary } from "./ErrorBoundary";

beforeAll(async () => {
  await i18n.changeLanguage("ja");
});
afterEach(cleanup);

function Boom(): never {
  throw new Error("描画で失敗した");
}

describe("ErrorBoundary", () => {
  test("想定外のエラーでエラー画面を出し、内容を POST /api/client-errors に送る(検索パラメーターは載せない)", async () => {
    const original = globalThis.fetch;
    const requests: { url: string; method: string; body: string }[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/api/me") {
        return Response.json({ error: { code: "UNAUTHENTICATED" } }, { status: 401 });
      }
      requests.push({ url: url.pathname, method: request.method, body: await request.text() });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    window.history.replaceState(null, "", "/projects/p1?q=secret");
    const consoleError = console.error;
    console.error = () => {};
    try {
      render(
        <QueryClientProvider client={new QueryClient()}>
          <ErrorBoundary>
            <Boom />
          </ErrorBoundary>
        </QueryClientProvider>,
      );
      expect(
        await screen.findByText("問題が発生しました。時間をおいてもう一度お試しください。"),
      ).toBeTruthy();
      // 未ログインなので戻り先はログイン
      expect(await screen.findByRole("link", { name: "ログインへ" })).toBeTruthy();
      const sent = requests.find((r) => r.url === "/api/client-errors");
      expect(sent?.method).toBe("POST");
      const body = JSON.parse(sent?.body ?? "{}");
      expect(body.message).toBe("描画で失敗した");
      expect(body.path).toBe("/projects/p1");
    } finally {
      console.error = consoleError;
      globalThis.fetch = original;
    }
  });
});
