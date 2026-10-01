export type DocumentKind = "google_doc" | "google_slides" | "google_sheets" | "pdf" | "other";

export type DriveLink = {
  googleFileId: string;
  /** docs.google.com のリンクだけが持つ。drive.google.com/file のリンクは中身の種類をリンクから決められない */
  kind: Exclude<DocumentKind, "pdf" | "other"> | null;
};

const DOCS_KINDS = {
  document: "google_doc",
  presentation: "google_slides",
  spreadsheets: "google_sheets",
} as const;

const FILE_ID = "[A-Za-z0-9_-]+";
// 複数アカウントでログインしているときの `/u/{n}/` は、同じファイルの別の表記として受け付ける。
// `/d/e/2PACX-...` は「ウェブに公開」のリンクでファイル ID ではないので、ドライブの資料にしない
const DOCS_PATH = new RegExp(
  `^/(document|presentation|spreadsheets)(?:/u/[0-9]+)?/d/(?!e/)(${FILE_ID})(?:/|$)`,
);
const DRIVE_FILE_PATH = new RegExp(`^/file/d/(${FILE_ID})(?:/|$)`);

function parseHttpUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url : null;
}

/** http または https で始まる URL か(design-spec 6.0.3) */
export function isHttpUrl(raw: string): boolean {
  return parseHttpUrl(raw) !== null;
}

/**
 * ドライブの資料(02-01 5.1)ならファイル ID を取り出す。
 * `docs.google.com/{document,presentation,spreadsheets}/d/{id}` と `drive.google.com/file/d/{id}` が対象。
 */
export function parseDriveLink(raw: string): DriveLink | null {
  const url = parseHttpUrl(raw);
  if (!url) return null;
  // 末尾のドット付き(docs.google.com.)も同じホスト
  const host = url.hostname.replace(/\.$/, "");
  if (host === "docs.google.com") {
    const m = DOCS_PATH.exec(url.pathname);
    if (!m) return null;
    return { googleFileId: m[2] as string, kind: DOCS_KINDS[m[1] as keyof typeof DOCS_KINDS] };
  }
  if (host === "drive.google.com") {
    const m = DRIVE_FILE_PATH.exec(url.pathname);
    return m ? { googleFileId: m[1] as string, kind: null } : null;
  }
  return null;
}

/**
 * リンクだけから決める種別の初期値(design-spec 6.2)。
 * drive.google.com/file のリンクは、資料名と更新日時を取れたときに元の場所の種類で決め直すので、
 * ここでは `other` を返す。
 */
export function detectKind(raw: string): DocumentKind {
  const drive = parseDriveLink(raw);
  if (drive?.kind) return drive.kind;
  const url = parseHttpUrl(raw);
  if (url && !drive && url.pathname.toLowerCase().endsWith(".pdf")) return "pdf";
  return "other";
}

/**
 * 同じ案件の中でリンクの重複を判定する値(`documents.link_key`。design-spec 6.0.4)。
 * ドライブの資料はファイル ID、それ以外は前後の空白を除いた URL で比べる。
 */
export function linkKey(raw: string): string {
  const drive = parseDriveLink(raw);
  return drive ? `g:${drive.googleFileId}` : `u:${raw.trim()}`;
}
