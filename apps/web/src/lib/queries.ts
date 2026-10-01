import { queryOptions } from "@tanstack/react-query";
import { client, unwrap } from "./api";

/**
 * セッションの有無の判定とヘッダーの表示に使う。401 を再試行しない。
 * 未ログインの判定そのものなので、失敗してもログイン画面へは送らない(送り先は呼び出し側が決める)。
 */
export const meQuery = queryOptions({
  queryKey: ["me"],
  meta: { probesSession: true },
  queryFn: () => unwrap(client.api.me.get()),
  retry: false,
  staleTime: Number.POSITIVE_INFINITY,
});

export const configQuery = queryOptions({
  queryKey: ["config"],
  queryFn: () => unwrap(client.api.config.get()),
  retry: false,
  staleTime: Number.POSITIVE_INFINITY,
});

export type Me = Awaited<ReturnType<NonNullable<typeof meQuery.queryFn>>>;
