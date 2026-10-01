/**
 * 画面向けの一時 Cookie(`wx_login_notice`・`wx_drive_notice`。02-01 5.2)を読んで消す。
 * 値は JSON を `encodeURIComponent` したもの。メールを URL に載せないための受け渡しで、1回読んだら消す。
 */
export function consumeNotice(name: "wx_login_notice" | "wx_drive_notice"): {
  code: string;
  email?: string;
} | null {
  const entry = document.cookie.split("; ").find((part) => part.startsWith(`${name}=`));
  if (!entry) return null;
  // biome-ignore lint/suspicious/noDocumentCookie: 同上
  document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(entry.slice(name.length + 1)));
    const { code, email } = parsed as { code?: unknown; email?: unknown };
    if (typeof code !== "string") return null;
    return typeof email === "string" ? { code, email } : { code };
  } catch {
    return null;
  }
}
