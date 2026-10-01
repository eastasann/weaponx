/** 再連携で Google の許可画面へ移り、終わったら今の画面へ戻る(design-spec 6.0.5) */
export function reconnectUrl(returnTo: string): string {
  return `/api/auth/google/reconnect?returnTo=${encodeURIComponent(returnTo)}`;
}

export function currentPath(): string {
  return window.location.pathname + window.location.search;
}
