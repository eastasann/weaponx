import type { QueryClient } from "@tanstack/react-query";
import type { AnyRouter } from "@tanstack/react-router";
import { isSafeReturnTo } from "@weaponx/shared";
import { toApiError } from "./errors";
import type { Me } from "./queries";

/**
 * どの画面の操作でも同じになる失敗の扱い(02-01 8章「フロントエンドでの表示方針」)。
 * 画面ごとの振る舞い(ダイアログを閉じる・欄の下に理由を出すなど)は各画面が決める。
 * - `UNAUTHENTICATED`: ログイン画面へ送り、ログイン後に今の画面へ戻す(design-spec 6.0.7)
 * - `ACCOUNT_SUSPENDED`: ログイン画面へ送る。停止の表示はサーバーが置く `wx_login_notice` で出す(6.0.2)
 * - `DRIVE_REAUTH_REQUIRED`: `GET /api/me` のキャッシュを要再連携に書き換える(帯とダイアログがここから決まる)
 */
export function handleGlobalError(error: unknown, queryClient: QueryClient, router: AnyRouter) {
  const { code } = toApiError(error);
  if (code === "DRIVE_REAUTH_REQUIRED") {
    queryClient.setQueryData<Me>(["me"], (me) =>
      me ? { ...me, drive: { status: "needs_reauth" } } : me,
    );
    return;
  }
  if (code !== "UNAUTHENTICATED" && code !== "ACCOUNT_SUSPENDED") return;
  if (router.state.location.pathname === "/login") return;
  const returnTo = router.state.location.pathname + router.state.location.searchStr;
  queryClient.removeQueries({ queryKey: ["me"] });
  router.navigate({
    to: "/login",
    search: code === "UNAUTHENTICATED" && isSafeReturnTo(returnTo) ? { returnTo } : {},
  });
}
