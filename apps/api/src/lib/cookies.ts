export type CookieOptions = {
  maxAge: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: "Lax" | "Strict";
  path?: string;
};

export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [
    `${name}=${value}`,
    `Path=${options.path ?? "/"}`,
    `Max-Age=${options.maxAge}`,
    `SameSite=${options.sameSite ?? "Lax"}`,
  ];
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie(
  name: string,
  options: Pick<CookieOptions, "httpOnly" | "secure" | "path">,
): string {
  return serializeCookie(name, "", { ...options, maxAge: 0 });
}

export function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

export function appendSetCookie(set: { headers: Record<string, unknown> }, cookie: string): void {
  const current = set.headers["set-cookie"];
  const list = Array.isArray(current) ? current : current ? [String(current)] : [];
  set.headers["set-cookie"] = [...list, cookie];
}
