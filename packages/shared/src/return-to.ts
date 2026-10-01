const MAX_LENGTH = 2048;

/**
 * ログイン後に戻る先として受け付けるパスか(02-01 4章)。
 * `/` で始まり、`//` で始まらない。`/\` はブラウザが `//` と同じに扱うので、バックスラッシュと
 * 制御文字(改行・タブを含む)も受け付けない。
 */
export function isSafeReturnTo(value: string): boolean {
  return (
    value.length <= MAX_LENGTH &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を弾くための判定
    !/[\\\u0000-\u001f\u007f]/.test(value)
  );
}

/** 受け付けられない `returnTo` は無かったものとして、ホームへ戻す */
export function safeReturnTo(value: string | null | undefined): string {
  return value && isSafeReturnTo(value) ? value : "/";
}
