import type { DocumentKind } from "@weaponx/shared";

const ICONS: Record<DocumentKind, string> = {
  google_doc: "▤",
  google_slides: "▣",
  google_sheets: "▦",
  pdf: "▢",
  other: "⛓",
};

/** 種別アイコン(design-spec 6.1)。種別は隣の文字でも伝わるので読み上げからは外す */
export function KindIcon({ kind }: { kind: DocumentKind }) {
  return (
    <span aria-hidden="true" className="shrink-0 text-text-muted">
      {ICONS[kind]}
    </span>
  );
}
