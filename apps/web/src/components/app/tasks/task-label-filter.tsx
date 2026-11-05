import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ChevronDown, Tag } from "lucide-react";
import type { TaskLabel } from "../../../../../server/src/tasks/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { TaskLabels } from "./task-labels";

/** Repeated label URL parameters compose with the board's existing navigation. */
export function TaskLabelFilter({ labels }: { labels: TaskLabel[] }) {
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const selected = [
    ...new Map(
      params
        .getAll("label")
        .filter(Boolean)
        .map((name) => [name.toLowerCase(), name])
    ).values(),
  ];
  const selectedKeys = new Set(selected.map((name) => name.toLowerCase()));
  const options = [
    ...labels,
    ...selected
      .filter(
        (name) =>
          !labels.some((l) => l.name.toLowerCase() === name.toLowerCase())
      )
      .map((name) => ({ name, color: "gray" })),
  ];
  const change = (next: string[]) => {
    const nextParams = new URLSearchParams(params);
    nextParams.delete("label");
    for (const name of next) nextParams.append("label", name);
    setParams(nextParams);
  };
  const toggle = (name: string) =>
    change(
      selectedKeys.has(name.toLowerCase())
        ? selected.filter((n) => n.toLowerCase() !== name.toLowerCase())
        : [...selected, name]
    );
  return (
    <Popover
      onOpenChange={(open) => {
        if (!open) setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          aria-label="Filter by labels"
          className="h-8 max-w-36 shrink-0 gap-1.5 px-2 text-xs font-normal text-muted-foreground"
        >
          <Tag className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">
            {selected.length === 0
              ? "All labels"
              : selected.length === 1
                ? selected[0]
                : `Labels · ${selected.length}`}
          </span>
          <ChevronDown className="h-3 w-3 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={8}
        className="flex h-64 max-h-[var(--radix-popover-content-available-height)] w-64 flex-col overflow-hidden p-0"
      >
        <div className="shrink-0 px-2 pb-1 pt-2">
          <Input
            aria-label="Find filter labels"
            placeholder="Find labels…"
            className="h-8 text-xs"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div
          role="group"
          aria-label="Match any selected label"
          className="min-h-0 flex-1 overflow-y-auto px-2"
        >
          {options
            .filter((l) =>
              l.name.toLowerCase().includes(search.trim().toLowerCase())
            )
            .map((label) => (
              <label
                key={label.name}
                className="flex min-h-8 cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-muted/70"
              >
                <Checkbox
                  aria-label={label.name}
                  checked={selectedKeys.has(label.name.toLowerCase())}
                  onCheckedChange={() => toggle(label.name)}
                  className="h-4 w-4"
                />
                <TaskLabels labels={[label]} />
              </label>
            ))}
          {!options.length && (
            <p className="px-1 py-2 text-xs text-muted-foreground">
              No project labels yet
            </p>
          )}
        </div>
        <div className="flex h-8 shrink-0 items-center justify-between border-t border-border/60 bg-muted/20 px-2">
          <span className="text-[10px] text-muted-foreground">
            Match any selected
          </span>
          <Button
            type="button"
            variant="ghost"
            className="h-6 px-1 text-[11px] text-muted-foreground"
            disabled={!selected.length}
            onClick={() => change([])}
          >
            Clear all
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
