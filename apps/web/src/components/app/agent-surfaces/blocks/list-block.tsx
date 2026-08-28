import { Fragment, useId, useState } from "react";
import {
  ArrowUpRight,
  ChevronDown,
  Square,
  SquareCheckBig,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Markdown } from "@/components/ui/markdown";
import { cn } from "@/lib/utils";
import type {
  ListBlock,
  SurfaceListItem,
} from "@/components/app/agent-surfaces/types";
import { BlockHeader } from "@/components/app/agent-surfaces/blocks/block-header";
import { ItemAction } from "@/components/app/agent-surfaces/blocks/item-action";
import type { SurfaceInteractionIndex } from "@/components/app/agent-surfaces/interaction-presentation";
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
    React.ComponentProps<typeof ItemAction>,
    "action" | "itemId" | "blockId"
  >;
}): JSX.Element {
  const statusTone = item.tone ?? "neutral";
  const content = (
    <>
      <div className="flex min-w-0 items-start gap-1">
        <Markdown
          variant="caption"
          className={cn(
            "min-w-0 flex-1 line-clamp-none text-xs text-foreground"
          )}
        >
          {item.text}
        </Markdown>
        {item.url && isAllowedSurfaceUrl(item.url) ? (
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${item.text}`}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-primary underline decoration-primary/40 underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
          >
            <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        ) : null}
      </div>
      {item.detail ? (
        <Markdown variant="caption">{item.detail}</Markdown>
      ) : null}
    </>
  );

  return (
    <li data-item-id={item.id} className="flex items-start gap-2 py-0.5">
      {style === "check" ? (
        item.checked ? (
          <SquareCheckBig
            data-check-state="checked"
            role="img"
            aria-label="Completed"
            className={cn(
              "mt-0.5 h-3.5 w-3.5 shrink-0",
              TONE_CLASSES[statusTone].text
            )}
          />
        ) : (
          <Square
            data-check-state="unchecked"
            role="img"
            aria-label="Not completed"
            className={cn(
              "mt-0.5 h-3.5 w-3.5 shrink-0",
              TONE_CLASSES[statusTone].text
            )}
          />
        )
      ) : (
        <span className="mt-0.5 shrink-0 text-[11px] text-muted-foreground">
          {style === "number" ? `${index + 1}.` : "•"}
        </span>
      )}
      <div className="min-w-0 flex-1">
        {content}
        {item.status || item.action ? (
          <div
            data-testid="list-item-affordances"
            className="mt-1 flex min-w-0 flex-wrap items-start gap-1.5"
          >
            {item.status ? (
              <Badge
                className={cn(
                  "max-w-full whitespace-normal break-words text-left text-[10px] leading-tight",
                  TONE_CLASSES[statusTone].badge
                )}
              >
                {item.status}
              </Badge>
            ) : null}
            {item.action ? (
              <ItemAction
                action={item.action}
                itemId={item.id}
                blockId={block.id}
                {...interactionProps}
              />
            ) : null}
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
                  className="mb-1 mt-2 text-[11px] font-medium text-muted-foreground"
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
