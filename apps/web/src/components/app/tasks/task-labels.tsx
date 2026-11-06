import { TASK_LABEL_NAME_MAX_LENGTH } from "@dispatch/shared";
import { Command as CommandPrimitive } from "cmdk";
import { cn } from "@/lib/utils";
import { useEffect, useRef, useState } from "react";
import {
  Settings,
  ArrowLeft,
  Check,
  ChevronDown,
  EyeOff,
  Plus,
  Tag,
  X,
} from "lucide-react";
import type { TaskLabel } from "../../../../../server/src/tasks/types";
import { useTaskBoard, useTaskLabelVisibility } from "@/hooks/use-tasks";
import { TaskLabelBadge } from "./task-label-badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandList,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { ColorPicker, PROJECT_COLORS, isHexColor } from "../color-picker";

export function TaskLabels({ labels = [] }: { labels?: TaskLabel[] }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {labels.slice(0, 3).map((label) => (
        <TaskLabelBadge key={label.name} label={label} />
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
  onPendingChange,
}: {
  projectId: string;
  value: TaskLabel[];
  onChange: (labels: TaskLabel[]) => void;
  disabled?: boolean;
  onPendingChange?: (pending: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const generation = useRef(0);
  const restoring = useRef(false);
  useEffect(() => {
    const scope = ++generation.current;
    return () => {
      generation.current = scope + 1;
      onPendingChange?.(false);
    };
  }, [projectId, onPendingChange]);
  const [manage, setManage] = useState(false);
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
      return true;
    } catch {
      return false; // Mutation error is displayed below.
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
    if (disabled || visibility.isPending) return;
    if (selected(label))
      onChange(
        value.filter((l) => l.name.toLowerCase() !== label.name.toLowerCase())
      );
    else if (value.length < 20) onChange([...value, label]);
  };
  const restoreAndAdd = async (label: TaskLabel) => {
    if (
      disabled ||
      visibility.isPending ||
      restoring.current ||
      value.length >= 20
    )
      return;
    const started = generation.current;
    restoring.current = true;
    onPendingChange?.(true);
    try {
      const restored = await setHidden(label, false);
      // Closing the draft or switching entities expires its selection callback.
      if (generation.current !== started) return;
      if (restored) {
        onChange([...value, label]);
        setName("");
      }
    } finally {
      restoring.current = false;
      if (generation.current === started) onPendingChange?.(false);
    }
  };
  const canCreate =
    !!name.trim() &&
    !hiddenMatch &&
    !options.some((l) => l.name.toLowerCase() === name.trim().toLowerCase());
  const tooLong = name.trim().length > TASK_LABEL_NAME_MAX_LENGTH;
  const invalid = [...name].some(
    (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127
  );
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setName("");
          setManage(false);
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          disabled={disabled}
          aria-label="Edit labels"
          className="h-auto min-h-7 max-w-full min-w-0 justify-start gap-1.5 px-1.5 py-1 text-xs font-normal text-muted-foreground"
        >
          {value.length ? (
            <span className="flex min-w-0 items-center gap-2 overflow-hidden">
              {value.slice(0, 2).map((l) => (
                <span
                  key={l.name}
                  className="flex min-w-0 items-center gap-1.5"
                >
                  <TaskLabelBadge label={l} />
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
        className="flex h-64 max-h-[var(--radix-popover-content-available-height)] w-64 max-w-[calc(100vw-2rem)] flex-col overflow-hidden p-0"
      >
        {manage ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="shrink-0 px-2 pb-1 pt-2">
              <Input
                aria-label="Find project labels"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Find a label…"
                className="h-8 min-w-0 text-xs"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-1">
              {[...existing, ...hidden]
                .filter((l) =>
                  l.name.toLowerCase().includes(name.trim().toLowerCase())
                )
                .map((label) => (
                  <div
                    key={label.name}
                    className="flex min-h-8 items-center gap-2 px-1 text-xs"
                  >
                    <TaskLabelBadge label={label} />
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={disabled || visibility.isPending}
                      className={cn(
                        "ml-auto h-7 shrink-0 text-muted-foreground",
                        isHidden(label) ? "px-1.5 text-[11px]" : "w-7 p-0"
                      )}
                      aria-label={
                        isHidden(label)
                          ? `Restore label ${label.name}`
                          : `Remove label ${label.name} from options`
                      }
                      title={
                        isHidden(label)
                          ? "Restore label"
                          : "Remove from options; keep task assignments"
                      }
                      onClick={() => {
                        void setHidden(label, !isHidden(label));
                      }}
                    >
                      {isHidden(label) ? (
                        "Restore"
                      ) : (
                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                      )}
                    </Button>
                  </div>
                ))}
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <Command
              label="Label name"
              shouldFilter={false}
              className={cn(
                "rounded-md border-0 bg-transparent shadow-none backdrop-blur-none [&>div]:border-0 [&>div:has(>input)]:shrink-0",
                canCreate ? "h-20 shrink-0" : "min-h-0 flex-1"
              )}
            >
              <div className="shrink-0 px-2 pb-1 pt-2">
                <CommandPrimitive.Input
                  asChild
                  value={name}
                  onValueChange={setName}
                >
                  <Input
                    aria-label="Label name"
                    placeholder="Find or create a label…"
                    aria-invalid={canCreate && tooLong}
                    aria-describedby="task-label-length"
                    className="h-8 min-w-0 text-xs"
                  />
                </CommandPrimitive.Input>
              </div>
              {(matching.length > 0 || !canCreate) && (
                <CommandList className="min-h-0 flex-1 max-h-none overflow-y-auto">
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
                          disabled ||
                          visibility.isPending ||
                          (!selected(label) && value.length >= 20)
                        }
                        onSelect={() => toggle(label)}
                        className="min-h-8 gap-2"
                      >
                        <TaskLabelBadge label={label} />
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
                    {hiddenMatch && !selected(hiddenMatch) && (
                      <CommandItem
                        value={hiddenMatch.name}
                        aria-label={`Restore and add ${hiddenMatch.name}`}
                        disabled={
                          disabled || visibility.isPending || value.length >= 20
                        }
                        onSelect={() => {
                          void restoreAndAdd(hiddenMatch);
                        }}
                        className="min-h-9 gap-2"
                      >
                        <TaskLabelBadge label={hiddenMatch} />
                        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                          Hidden · Restore &amp; add
                        </span>
                      </CommandItem>
                    )}
                    {!matching.length && !canCreate && !hiddenMatch && (
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
            {canCreate && (
              <p
                id="task-label-length"
                role={tooLong ? "alert" : undefined}
                className="px-3 text-xs text-muted-foreground"
              >
                {tooLong
                  ? `Use ${TASK_LABEL_NAME_MAX_LENGTH} characters or fewer`
                  : `${name.trim().length}/${TASK_LABEL_NAME_MAX_LENGTH} characters`}
              </p>
            )}
            {canCreate && (
              <div className="shrink-0 px-2 pb-2 pt-1">
                <ColorPicker
                  value={color}
                  onChange={setColor}
                  disabled={disabled || visibility.isPending}
                  label="Label color"
                />
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={`Create “${name.trim()}”`}
                  disabled={
                    disabled ||
                    visibility.isPending ||
                    invalid ||
                    tooLong ||
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
          </div>
        )}
        {visibility.error && (
          <p role="alert" className="px-3 pb-2 text-xs text-destructive">
            {visibility.error.message}
          </p>
        )}
        <div className="flex h-8 shrink-0 items-center border-t border-border/60 bg-muted/20 px-2">
          <Button
            type="button"
            variant="ghost"
            aria-label={manage ? "Back to label picker" : "Manage labels"}
            className="h-6 w-full justify-start gap-1.5 px-1 text-[11px] text-muted-foreground"
            onClick={() => {
              setManage(!manage);
              setName("");
            }}
          >
            {manage ? (
              <>
                <ArrowLeft className="h-3 w-3 shrink-0" aria-hidden="true" />
                Back
              </>
            ) : (
              <>
                <Settings className="h-3 w-3 shrink-0" aria-hidden="true" />
                Manage
              </>
            )}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
