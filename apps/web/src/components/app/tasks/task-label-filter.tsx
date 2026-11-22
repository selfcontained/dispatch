import { useSearchParams } from "react-router-dom";
import type { TaskLabel } from "../../../../../server/src/tasks/types";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxItem,
  ComboboxTrigger,
} from "@/components/ui/combobox";
import { TaskLabelBadge } from "./task-label-badge";

/** Repeated label URL parameters compose with the board's existing navigation. */
export function TaskLabelFilter({ labels }: { labels: TaskLabel[] }) {
  const [params, setParams] = useSearchParams();
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
    <Combobox>
      <ComboboxTrigger
        size="sm"
        aria-label="Filter by labels"
        className="w-36 flex-1 basis-0 md:flex-none md:basis-auto"
      >
        {selected.length === 0 ? (
          "All labels"
        ) : selected.length === 1 ? (
          <TaskLabelBadge
            label={
              labels.find(
                (l) => l.name.toLowerCase() === selected[0].toLowerCase()
              ) ?? { name: selected[0], color: "gray" }
            }
          />
        ) : (
          `Labels · ${selected.length}`
        )}
      </ComboboxTrigger>
      <ComboboxContent
        label="Find filter labels"
        placeholder="Find labels…"
        emptyMessage={
          options.length ? "No labels match." : "No project labels yet"
        }
        className="w-64"
        footer={
          <div className="flex min-h-8 shrink-0 items-center justify-between border-t border-border-subtle bg-surface-subtle px-2">
            <span className="text-label-xs text-muted-foreground">
              Match any selected
            </span>
            <Button
              size="xs"
              type="button"
              variant="ghost"
              className="text-label-sm"
              disabled={!selected.length}
              onClick={() => change([])}
            >
              Clear all
            </Button>
          </div>
        }
      >
        {options.map((label) => (
          <ComboboxItem
            key={label.name}
            value={label.name}
            aria-label={label.name}
            keepOpen
            selected={selectedKeys.has(label.name.toLowerCase())}
            onSelect={() => toggle(label.name)}
          >
            <TaskLabelBadge label={label} />
          </ComboboxItem>
        ))}
      </ComboboxContent>
    </Combobox>
  );
}
