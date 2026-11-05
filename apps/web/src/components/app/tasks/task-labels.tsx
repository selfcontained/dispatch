import { useState } from "react";
import { ArrowLeft, Check, ChevronDown, EyeOff, Plus, Tag } from "lucide-react";
import type { TaskLabel } from "../../../../../server/src/tasks/types";
import { useTaskBoard, useTaskLabelVisibility } from "@/hooks/use-tasks";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { ColorPicker, PROJECT_COLORS, isHexColor } from "../color-picker";

const legacyColors: Record<string, string> = {
  gray: "#a5aab7",
  red: "#ef6c57",
  orange: "#dda348",
  green: "#74b85c",
  blue: "#649feb",
  purple: "#9575ed",
};
function LabelName({ label }: { label: TaskLabel }) {
  return (
    <>
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full"
        style={{
          backgroundColor:
            legacyColors[label.color] ??
            (isHexColor(label.color) ? label.color : legacyColors.gray),
        }}
      />
      <span className="min-w-0 truncate">{label.name}</span>
    </>
  );
}
export function TaskLabels({ labels = [] }: { labels?: TaskLabel[] }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {labels.slice(0, 3).map((label) => (
        <Badge
          key={label.name}
          title={label.name}
          className="max-w-32 gap-1.5 rounded border-border/60 bg-muted/30 px-1.5 py-0 text-[11px] font-normal normal-case tracking-normal text-muted-foreground"
        >
          <LabelName label={label} />
        </Badge>
      ))}
      {labels.length > 3 && (
        <span
          title={labels
            .slice(3)
            .map((l) => l.name)
            .join(", ")}
          className="text-[10px] text-muted-foreground"
        >
          +{labels.length - 3}
        </span>
      )}
    </div>
  );
}
export function TaskLabelPicker({
  projectId,
  value,
  onChange,
  disabled = false,
}: {
  projectId: string;
  value: TaskLabel[];
  onChange: (labels: TaskLabel[]) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [manage, setManage] = useState(false);
  const [notice, setNotice] = useState("");
  const visibility = useTaskLabelVisibility(projectId);
  const { data, isLoading } = useTaskBoard(open ? projectId : null);
  const [name, setName] = useState("");
  const [color, setColor] = useState(PROJECT_COLORS[0]!);
  const existing = data?.labels ?? [];
  const hidden = data?.hiddenLabels ?? [];
  const hiddenMatch = hidden.find(
    (l) => l.name.toLowerCase() === name.trim().toLowerCase()
  );
  const isHidden = (label: TaskLabel) =>
    hidden.some((l) => l.name.toLowerCase() === label.name.toLowerCase());
  const setHidden = async (label: TaskLabel, hide: boolean) => {
    if (disabled || visibility.isPending) return;
    try {
      await visibility.mutateAsync({ name: label.name, hidden: hide });
      setNotice(
        hide
          ? `“${label.name}” hidden. Existing tasks keep it.`
          : `“${label.name}” restored.`
      );
    } catch {
      /* Mutation error is displayed below. */
    }
  };
  const options = [
    ...existing,
    ...value.filter(
      (l) =>
        !existing.some((e) => e.name.toLowerCase() === l.name.toLowerCase())
    ),
  ];
  const selected = (label: TaskLabel) =>
    value.some((l) => l.name.toLowerCase() === label.name.toLowerCase());
  const matching = options.filter((l) =>
    l.name.toLowerCase().includes(name.trim().toLowerCase())
  );
  const toggle = (label: TaskLabel) => {
    if (disabled) return;
    if (selected(label))
      onChange(
        value.filter((l) => l.name.toLowerCase() !== label.name.toLowerCase())
      );
    else if (value.length < 20) onChange([...value, label]);
  };
  const canCreate =
    !!name.trim() &&
    !hiddenMatch &&
    !options.some((l) => l.name.toLowerCase() === name.trim().toLowerCase());
  const invalid = [...name].some(
    (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          disabled={disabled}
          aria-label="Edit labels"
          className="h-7 max-w-full min-w-0 justify-start gap-1.5 px-1.5 text-xs font-normal text-muted-foreground"
        >
          {value.length ? (
            <span className="flex min-w-0 items-center gap-2 overflow-hidden">
              {value.slice(0, 2).map((l) => (
                <span
                  key={l.name}
                  className="flex min-w-0 items-center gap-1.5"
                >
                  <LabelName label={l} />
                </span>
              ))}
              {value.length > 2 && (
                <span className="shrink-0">+{value.length - 2}</span>
              )}
            </span>
          ) : (
            <>
              <Tag className="h-3.5 w-3.5 shrink-0" />
              Add labels
            </>
          )}
          <ChevronDown className="ml-0.5 h-3 w-3 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        collisionPadding={8}
        className="w-64 max-w-[calc(100vw-2rem)] p-0"
      >
        {manage ? (
          <div className="p-2">
            <div className="mb-2 flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                aria-label="Back to label picker"
                onClick={() => {
                  setManage(false);
                  setName("");
                }}
              >
                <ArrowLeft className="h-3.5 w-3.5" />
              </Button>
              <span className="text-xs font-medium">Project labels</span>
            </div>
            <Input
              aria-label="Find project labels"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Find a label…"
              className="mb-1 h-8 text-xs"
            />
            <div className="max-h-48 overflow-auto">
              {[...existing, ...hidden]
                .filter((l) =>
                  l.name.toLowerCase().includes(name.trim().toLowerCase())
                )
                .map((label) => (
                  <div
                    key={label.name}
                    className="flex min-h-8 items-center gap-2 px-1 text-xs"
                  >
                    <LabelName label={label} />
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={disabled || visibility.isPending}
                      className="ml-auto h-7 shrink-0 px-1.5 text-[11px]"
                      aria-label={`${isHidden(label) ? "Restore" : "Hide"} label ${label.name}`}
                      onClick={() => {
                        void setHidden(label, !isHidden(label));
                      }}
                    >
                      {isHidden(label) ? "Restore" : "Hide"}
                    </Button>
                  </div>
                ))}
            </div>
            <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
              Hidden labels stay on existing tasks. Restore them here to use
              them again.
            </p>
          </div>
        ) : (
          <>
            <Command
              label="Label name"
              shouldFilter={false}
              className="rounded-md border-0 bg-transparent shadow-none backdrop-blur-none [&>div]:border-0"
            >
              <CommandInput
                aria-label="Label name"
                placeholder="Find or create a label…"
                value={name}
                maxLength={40}
                onValueChange={setName}
                className="h-8 text-xs"
              />
              {(matching.length > 0 || !canCreate) && (
                <CommandList className="max-h-48">
                  <CommandGroup>
                    {matching.map((label) => (
                      <CommandItem
                        key={label.name}
                        value={label.name}
                        aria-label={label.name}
                        aria-description={
                          selected(label) ? "Applied to task" : "Not applied"
                        }
                        disabled={
                          disabled || (!selected(label) && value.length >= 20)
                        }
                        onSelect={() => toggle(label)}
                        className="min-h-8 gap-2"
                      >
                        <LabelName label={label} />
                        {isHidden(label) && (
                          <EyeOff
                            className="h-3 w-3 shrink-0 text-muted-foreground"
                            aria-label="Hidden from future choices"
                          />
                        )}
                        {selected(label) && (
                          <Check
                            aria-hidden="true"
                            className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground"
                          />
                        )}
                      </CommandItem>
                    ))}
                    {!matching.length && !canCreate && (
                      <p className="px-2 py-3 text-xs text-muted-foreground">
                        {isLoading
                          ? "Loading labels…"
                          : "Type a name to create a label"}
                      </p>
                    )}
                  </CommandGroup>
                </CommandList>
              )}
            </Command>
            {hiddenMatch && !selected(hiddenMatch) && (
              <div className="px-2 pb-2">
                <p className="mb-1 text-[10px] text-muted-foreground">
                  This label is hidden from choices.
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={disabled || visibility.isPending}
                  className="h-7 text-xs"
                  onClick={() => {
                    void setHidden(hiddenMatch, false);
                  }}
                >
                  Restore label
                </Button>
              </div>
            )}
            {canCreate && (
              <div className="px-2 pb-2 pt-1">
                <ColorPicker
                  value={color}
                  onChange={setColor}
                  disabled={disabled}
                  label="Label color"
                />
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={`Create “${name.trim()}”`}
                  disabled={
                    disabled ||
                    invalid ||
                    !isHexColor(color) ||
                    value.length >= 20
                  }
                  className="mt-1 h-8 w-full min-w-0 justify-start gap-2 px-1 text-xs"
                  onClick={() => {
                    toggle({ name: name.trim(), color });
                    setName("");
                  }}
                >
                  <Plus className="h-3.5 w-3.5 shrink-0" />
                  <span className="shrink-0">Create</span>
                  <span className="min-w-0 truncate">“{name.trim()}”</span>
                </Button>
              </div>
            )}
            <div className="px-2 pb-1">
              <Button
                type="button"
                variant="ghost"
                className="h-7 w-full justify-start px-1 text-[11px] text-muted-foreground"
                onClick={() => {
                  setManage(true);
                  setName("");
                  setNotice("");
                }}
              >
                Manage labels
              </Button>
            </div>
          </>
        )}
        {notice && (
          <p
            role="status"
            className="px-3 pb-2 text-[10px] leading-4 text-muted-foreground"
          >
            {notice}
          </p>
        )}
        {visibility.error && (
          <p role="alert" className="px-3 pb-2 text-xs text-destructive">
            {visibility.error.message}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
