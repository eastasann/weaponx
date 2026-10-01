import { describe, expect, mock, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { AnyRouter } from "@tanstack/react-router";
import { ApiError } from "./errors";
import type { Me } from "./queries";
import { handleGlobalError } from "./session-effects";

const me: Me = {
  user: {
    id: "u1",
    email: "tanaka@example.com",
    displayName: "田中 美咲",
    avatarUrl: null,
    globalRole: "member",
    locale: "ja",
  },
  drive: { status: "active" },
} as Me;

function setup(pathname = "/projects/p1", searchStr = "?series=s1") {
  const queryClient = new QueryClient();
  queryClient.setQueryData(["me"], me);
  const navigate = mock(() => Promise.resolve());
  const router = { state: { location: { pathname, searchStr } }, navigate } as unknown as AnyRouter;
  return { queryClient, router, navigate };
}

describe("handleGlobalError", () => {
  test("UNAUTHENTICATED はログイン画面へ送り、今の画面を returnTo にする(6.0.7)", () => {
    const { queryClient, router, navigate } = setup();
    handleGlobalError(new ApiError("UNAUTHENTICATED", { status: 401 }), queryClient, router);
    expect(navigate).toHaveBeenCalledWith({
      to: "/login",
      search: { returnTo: "/projects/p1?series=s1" },
    });
    expect(queryClient.getQueryData(["me"])).toBeUndefined();
  });

  test("ACCOUNT_SUSPENDED は returnTo を付けずにログイン画面へ送る(6.0.2)", () => {
    const { queryClient, router, navigate } = setup();
    handleGlobalError(new ApiError("ACCOUNT_SUSPENDED", { status: 401 }), queryClient, router);
    expect(navigate).toHaveBeenCalledWith({ to: "/login", search: {} });
  });

  test("ログイン画面では何もしない(送り先が循環しない)", () => {
    const { queryClient, router, navigate } = setup("/login", "");
    handleGlobalError(new ApiError("UNAUTHENTICATED", { status: 401 }), queryClient, router);
    expect(navigate).not.toHaveBeenCalled();
  });

  test("DRIVE_REAUTH_REQUIRED は me のキャッシュを要再連携に書き換える(02-01 8章)", () => {
    const { queryClient, router, navigate } = setup();
    handleGlobalError(new ApiError("DRIVE_REAUTH_REQUIRED", { status: 409 }), queryClient, router);
    expect(queryClient.getQueryData<Me>(["me"])?.drive.status).toBe("needs_reauth");
    expect(navigate).not.toHaveBeenCalled();
  });

  test("ほかのエラーは何もしない", () => {
    const { queryClient, router, navigate } = setup();
    handleGlobalError(new ApiError("PROJECT_NOT_FOUND", { status: 404 }), queryClient, router);
    expect(navigate).not.toHaveBeenCalled();
    expect(queryClient.getQueryData<Me>(["me"])?.drive.status).toBe("active");
  });
});
