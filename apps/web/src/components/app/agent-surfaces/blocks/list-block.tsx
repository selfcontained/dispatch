import { Check, Circle, CircleDot, OctagonAlert } from "lucide-react";

import { Markdown } from "@/components/ui/markdown";
import { cn } from "@/lib/utils";
import type {
  ListBlock,
  SurfaceListItem,
} from "@/components/app/agent-surfaces/types";
import { BlockHeader } from "@/components/app/agent-surfaces/blocks/block-header";

const STATE_ICON: Record<
  NonNullable<SurfaceListItem["state"]>,
  typeof Check
> = {
  pending: Circle,
  active: CircleDot,
  done: Check,
  blocked: OctagonAlert,
};

const STATE_CLASS: Record<NonNullable<SurfaceListItem["state"]>, string> = {
  pending: "text-muted-foreground",
  active: "text-status-working",
  done: "text-status-done",
  blocked: "text-status-blocked",
};

function ListItemRow({
  item,
  style,
  index,
}: {
  item: SurfaceListItem;
  style: NonNullable<ListBlock["style"]>;
  index: number;
}): JSX.Element {
  if (style === "check") {
    const Icon = item.state ? STATE_ICON[item.state] : Circle;
    return (
      <li data-item-id={item.id} className="flex items-start gap-2 py-0.5">
        <Icon
          className={cn(
            "mt-0.5 h-3.5 w-3.5 shrink-0",
            item.state ? STATE_CLASS[item.state] : "text-muted-foreground",
            item.state === "done" && "opacity-80"
          )}
        />
        <div className="min-w-0 flex-1">
          <Markdown
            variant="caption"
            className={cn(
              "line-clamp-none text-xs text-foreground",
              item.state === "done" && "text-muted-foreground line-through"
            )}
          >
            {item.text}
          </Markdown>
          {item.detail ? (
            <Markdown variant="caption">{item.detail}</Markdown>
          ) : null}
        </div>
      </li>
    );
  }

  return (
    <li data-item-id={item.id} className="flex items-start gap-2 py-0.5">
      <span className="mt-0.5 shrink-0 text-[11px] text-muted-foreground">
        {style === "number" ? `${index + 1}.` : "•"}
      </span>
      <div className="min-w-0 flex-1">
        <Markdown
          variant="caption"
          className="line-clamp-none text-xs text-foreground"
        >
          {item.text}
        </Markdown>
        {item.detail ? (
          <Markdown variant="caption">{item.detail}</Markdown>
        ) : null}
      </div>
    </li>
  );
}

export function ListBlockView({ block }: { block: ListBlock }): JSX.Element {
  const style = block.style ?? "bullet";
  return (
    <div data-block-id={block.id} data-block-type="list">
      <BlockHeader title={block.title} description={block.description} />
      <ul className="space-y-0.5">
        {block.items.map((item, index) => (
          <ListItemRow key={item.id} item={item} style={style} index={index} />
        ))}
      </ul>
    </div>
  );
}
