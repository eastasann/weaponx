import { useEffect, useState } from "react";

/** 入力が止まってから値を反映する(design-spec 6.1・6.4) */
/** 入力が止まったとみなす時間(ミリ秒) */
export const SEARCH_DEBOUNCE_MS = 300;

export function useDebouncedValue<T>(value: T, delayMs = SEARCH_DEBOUNCE_MS): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
