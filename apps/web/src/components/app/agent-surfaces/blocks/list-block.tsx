import { Fragment, useId, useState } from "react";
import { ArrowUpRight, Check, ChevronDown, Circle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Markdown } from "@/components/ui/markdown";
import { cn } from "@/lib/utils";
import type {
  ListBlock,
  SurfaceListItem,
} from "@/components/app/agent-surfaces/types";
import { BlockHeader } from "@/components/app/agent-surfaces/blocks/block-header";
import { ItemActions } from "@/components/app/agent-surfaces/blocks/item-actions";
import type { SurfaceInteractionIndex } from "@/components/app/agent-surfaces/interaction-presentation";
import { humanizeLabel } from "@/components/app/agent-surfaces/format";
import { isAllowedSurfaceUrl } from "@/components/app/agent-surfaces/surface-url";
import { TONE_CLASSES } from "@/components/app/agent-surfaces/tone";

function ListItemRow({
  item,
  style,
  index,
  block,
  interactionProps,
}: {
  item: SurfaceListItem;
  style: NonNullable<ListBlock["style"]>;
  index: number;
  block: ListBlock;
  interactionProps: Omit<
    React.ComponentProps<typeof ItemActions>,
    "actions" | "itemId" | "blockId" | "itemLabel"
  >;
}): JSX.Element {
  const statusTone = item.tone ?? "neutral";
  const linked = item.url && isAllowedSurfaceUrl(item.url);
  const text = (
    <Markdown
      variant="caption"
      className={cn(
        "min-w-0 line-clamp-none text-xs text-foreground/90",
        // Inside a link the markdown must flow inline so the ↗ glyph sits
        // after the last word instead of wrapping to its own line.
        linked && "inline [&_*]:inline"
      )}
    >
      {item.text}
    </Markdown>
  );

  return (
    <li data-item-id={item.id} className="flex items-start gap-2 py-0.5">
      {style === "check" ? (
        item.checked ? (
          <Check
            data-check-state="checked"
            role="img"
            aria-label="Completed"
            className={cn(
              "mt-0.5 h-3.5 w-3.5 shrink-0 stroke-[2.5]",
              TONE_CLASSES[item.tone ?? "success"].text
            )}
          />
        ) : (
          // An incomplete item has no outcome yet, so the glyph is a plain
          // outline regardless of the item's tone (which still colors the
          // status badge below).
          <Circle
            data-check-state="unchecked"
            role="img"
            aria-label="Not completed"
            className="mt-0.5 h-3.5 w-3.5 shrink-0 stroke-[2] text-muted-foreground/70"
          />
        )
      ) : (
        <span className="mt-0.5 shrink-0 text-[11px] text-muted-foreground">
          {style === "number" ? `${index + 1}.` : "•"}
        </span>
      )}
      <div className="min-w-0 flex-1">
        {/* Two-column row: the action column is a fixed right rail so
            ownership is positional, and an actionable item costs no extra
            height. */}
        <div className="flex min-w-0 items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            {linked ? (
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer"
                className="group/link max-w-full rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {text}
                <ArrowUpRight
                  aria-hidden="true"
                  className="ml-0.5 inline h-3 w-3 align-text-top text-muted-foreground group-hover/link:text-foreground"
                />
              </a>
            ) : (
              text
            )}
          </div>
          {item.actions?.length ? (
            <ItemActions
              actions={item.actions}
              itemId={item.id}
              blockId={block.id}
              itemLabel={item.text}
              {...interactionProps}
            />
          ) : null}
        </div>
        {item.detail ? (
          <Markdown variant="caption">{item.detail}</Markdown>
        ) : null}
        {item.status ? (
          <div className="mt-0.5">
            <Badge
              className={cn(
                "max-w-full whitespace-normal break-words text-left text-[10px] normal-case leading-tight tracking-normal",
                TONE_CLASSES[statusTone].badge
              )}
            >
              {humanizeLabel(item.status)}
            </Badge>
          </div>
        ) : null}
      </div>
    </li>
  );
}

export function ListBlockView({
  block,
  ...interactionProps
}: {
  block: ListBlock;
  agentId: string;
  surfaceId: string;
  surfaceRevision: number;
  interactions: SurfaceInteractionIndex;
  onRequestRefresh: () => Promise<void>;
  readOnly: boolean;
  idPrefix: string;
}): JSX.Element {
  const style = block.style ?? "bullet";
  const [collapsed, setCollapsed] = useState(
    () => !!block.collapse && block.items.length > block.collapse.after
  );
  const regionId = useId();
  const collapseAfter = block.collapse?.after;
  const canCollapse =
    collapseAfter !== undefined && block.items.length > collapseAfter;
  const visibleItems =
    collapsed && collapseAfter !== undefined
      ? block.items.slice(0, collapseAfter)
      : block.items;
  let previousGroup: string | undefined;

  return (
    <div data-block-id={block.id} data-block-type="list">
      <BlockHeader
        title={block.title}
        description={block.description}
        count={block.showItemCount ? block.items.length : undefined}
      />
      <ul id={regionId} className="space-y-0.5">
        {visibleItems.map((item, index) => {
          const group = item.group;
          const showGroup = group && group !== previousGroup;
          previousGroup = group;
          return (
            <Fragment key={item.id}>
              {showGroup ? (
                <li
                  role="presentation"
                  className="mb-1 mt-2.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground first:mt-0"
                >
                  {group}
                </li>
              ) : null}
              <ListItemRow
                item={item}
                style={style}
                index={index}
                block={block}
                interactionProps={interactionProps}
              />
            </Fragment>
          );
        })}
      </ul>
      {canCollapse ? (
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls={regionId}
          onClick={() => setCollapsed((value) => !value)}
          className="mt-1 inline-flex min-h-7 items-center gap-1 rounded px-1 text-[11px] text-primary underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-11"
        >
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 transition-transform",
              !collapsed && "rotate-180"
            )}
          />
          {collapsed
            ? (block.collapse?.label ?? `Show all ${block.items.length} items`)
            : "Show less"}
        </button>
      ) : null}
    </div>
  );
}
