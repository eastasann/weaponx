import { HoverCard } from "radix-ui";
import { useTranslation } from "react-i18next";
import { Badge } from "../../components/Badge";
import type { SeriesRow } from "../../lib/queries";
import { splitTags, tagLabel } from "./series-view";

/** 表の行のタグ。先頭から `limit` 個まで出し、残りは「+n」にまとめて載せると一覧で出す(design-spec 6.1) */
export function TagBadges({ tags, limit }: { tags: SeriesRow["tags"]; limit: number }) {
  const { t } = useTranslation();
  const { shown, rest } = splitTags(tags, limit);
  return (
    <>
      {shown.map((tag) => (
        <Badge key={tag.label}>{tagLabel(tag)}</Badge>
      ))}
      {rest.length > 0 && (
        <HoverCard.Root openDelay={100}>
          <HoverCard.Trigger asChild>
            <button type="button" className="shrink-0 rounded-[var(--radius-chip)]">
              <Badge>{t("project.moreTags", { count: rest.length })}</Badge>
            </button>
          </HoverCard.Trigger>
          <HoverCard.Portal>
            <HoverCard.Content
              side="bottom"
              align="start"
              sideOffset={4}
              className="typography-caption z-30 flex flex-col gap-[var(--space-tight)] rounded-[var(--radius-surface)] border border-border bg-surface p-[var(--space-inline-gap)] text-text shadow-[var(--shadow-popover)]"
            >
              {rest.map((tag) => (
                <span key={tag.label}>{tagLabel(tag)}</span>
              ))}
            </HoverCard.Content>
          </HoverCard.Portal>
        </HoverCard.Root>
      )}
    </>
  );
}
