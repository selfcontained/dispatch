import { useState } from "react";

import {
  AgentIdLabel,
  CopyButton,
  DeleteButton,
  RelativeTime,
  formatPrimitive,
} from "@/components/app/brain-card-shared";
import { useBrainListItems, type BrainList } from "@/hooks/use-brain";
import { cn } from "@/lib/utils";

// ── List card with inline items ─────────────────────────────────

function ListItemRow({
  value,
  index,
  createdAt,
}: {
  value: unknown;
  index: number;
  createdAt: string;
}): JSX.Element {
  const isObject =
    value !== null && typeof value === "object" && !Array.isArray(value);
  const entries = isObject
    ? [
        ...Object.entries(value as Record<string, unknown>),
        ["createdAt", createdAt],
      ]
    : [
        ["value", value],
        ["createdAt", createdAt],
      ];

  return (
    <div className="flex gap-2 px-2.5 py-1.5 text-xs font-mono border-b border-border/50 last:border-b-0 min-w-0">
      <span className="text-muted-foreground shrink-0 w-4 text-right pt-px">
        {index}
      </span>
      <div className="flex-1 min-w-0 overflow-x-auto">
        {entries.map(([k, v]) => {
          const fmt = formatPrimitive(v);
          return (
            <div
              key={k as string}
              className="flex gap-1.5 leading-relaxed min-w-0"
            >
              <span className="text-sky-400 shrink-0">{k as string}:</span>
              <span className={cn(fmt.className, "whitespace-nowrap")}>
                {fmt.text}
              </span>
            </div>
          );
        })}
      </div>
      <CopyButton value={value} className="shrink-0 mt-px" />
    </div>
  );
}

export function ListCard({
  list,
  repoRoot,
  agentId,
  onDelete,
}: {
  list: BrainList;
  repoRoot: string;
  agentId?: string;
  onDelete?: () => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(list.itemCount <= 5);
  const { data } = useBrainListItems(repoRoot, list.collection, list.name, {
    limit: expanded ? 50 : 5,
    order: "asc",
  });

  const items = data?.items ?? [];
  const allItemValues = items.map((item) => item.value);

  return (
    <div className="mx-3 mb-2 rounded-md border border-border bg-muted/20 p-2.5 overflow-hidden">
      <div className="flex items-center justify-between gap-2 mb-2 min-w-0">
        <div className="flex items-center gap-1.5 text-xs min-w-0">
          <span className="rounded bg-violet-950/50 px-1.5 py-0.5 font-mono text-violet-400 text-[10px] shrink-0">
            {list.collection}
          </span>
          <span className="font-medium truncate">{list.name}</span>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground shrink-0">
          {agentId ? <AgentIdLabel agentId={agentId} /> : null}
          {items.length > 0 ? <CopyButton value={allItemValues} /> : null}
          {onDelete ? (
            <DeleteButton
              label={`Delete list ${list.name}`}
              onClick={onDelete}
            />
          ) : null}
          <span>{list.itemCount} items</span>
          <RelativeTime iso={list.updatedAt} />
        </div>
      </div>
      {items.length > 0 ? (
        <div className="rounded bg-muted/30 overflow-hidden">
          {items.map((item) => (
            <ListItemRow
              key={item.index}
              value={item.value}
              index={item.index}
              createdAt={item.createdAt}
            />
          ))}
          {!expanded && list.itemCount > 5 ? (
            <button
              onClick={() => setExpanded(true)}
              className="w-full px-2.5 py-1.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors text-center"
            >
              {list.itemCount <= 50
                ? `Show all ${list.itemCount} items`
                : `Show first 50 of ${list.itemCount} items`}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
