import { useSyncExternalStore } from "react";

/** メディアクエリの一致を購読する。モバイル(<768px。design-spec 4.3)の判定に使う */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export const useIsMobile = () => useMediaQuery("(max-width: 767px)");
