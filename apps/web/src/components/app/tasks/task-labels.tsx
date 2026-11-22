import { TASK_LABEL_NAME_MAX_LENGTH } from "@dispatch/shared";
import { useEffect, useRef, useState } from "react";
import {
  Settings,
  ArrowLeft,
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
  Combobox,
  ComboboxContent,
  ComboboxItem,
  ComboboxTrigger,
  searchRank,
} from "@/components/ui/combobox";
import { FieldError } from "@/components/ui/field";
import { IconButton } from "@/components/ui/icon-button";
import { RowButton } from "@/components/ui/row-button";
import { Hint } from "@/components/ui/tooltip";
import { ColorPicker, PROJECT_COLORS, isHexColor } from "../color-picker";
import { failureHint } from "@/lib/errors";

export function TaskLabels({ labels = [] }: { labels?: TaskLabel[] }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {labels.slice(0, 3).map((label) => (
        <TaskLabelBadge key={label.name} label={label} />
      ))}
      {labels.length > 3 && (
        <Hint
          label={labels
            .slice(3)
            .map((l) => l.name)
            .join(", ")}
        >
          <span className="text-label-xs text-muted-foreground">
            +{labels.length - 3}
          </span>
        </Hint>
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
  const { data, isLoading, isError, refetch } = useTaskBoard(
    open ? projectId : null
  );
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
  const matching = options
    .map((label) => ({ label, rank: searchRank(label.name, name) }))
    .filter(({ rank }) => rank > 0)
    .sort((a, b) => b.rank - a.rank)
    .map(({ label }) => label);
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
  const status =
    matching.length || canCreate || hiddenMatch
      ? undefined
      : isLoading
        ? "Loading labels…"
        : isError && !data
          ? "Couldn’t load labels."
          : undefined;
  const manageList = (
    <div className="flex h-56 min-h-0 flex-col">
      <div className="shrink-0 px-2 pb-1 pt-2">
        <Input
          aria-label="Find project labels"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Find a label…"
          className="h-8 min-w-0 text-body-sm"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-1">
        {[...existing, ...hidden]
          .filter((l) => searchRank(l.name, name) > 0)
          .map((label) => (
            <div
              key={label.name}
              className="flex min-h-8 items-center gap-2 px-1 text-body-sm"
            >
              <TaskLabelBadge label={label} />
              {isHidden(label) ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={disabled || visibility.isPending}
                  className="ml-auto shrink-0 text-label-sm"
                  aria-label={`Restore label ${label.name}`}
                  onClick={() => {
                    void setHidden(label, false);
                  }}
                >
                  Restore
                </Button>
              ) : (
                <IconButton
                  tooltip="Remove from options; keep task assignments"
                  size="icon-sm"
                  disabled={disabled || visibility.isPending}
                  className="ml-auto"
                  label={`Remove label ${label.name} from options`}
                  onClick={() => {
                    void setHidden(label, true);
                  }}
                >
                  <X aria-hidden="true" />
                </IconButton>
              )}
            </div>
          ))}
      </div>
    </div>
  );
  return (
    <Combobox
      open={open}
      search={name}
      onSearchChange={setName}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setManage(false);
      }}
    >
      <ComboboxTrigger asChild disabled={disabled} aria-label="Edit labels">
        <RowButton className="min-h-7 w-auto max-w-full min-w-0 gap-1.5 px-1.5 py-1 text-body-sm text-muted-foreground">
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
              <Tag className="size-icon-md shrink-0" />
              Add labels
            </>
          )}
          <ChevronDown className="size-icon-sm shrink-0 opacity-60" />
        </RowButton>
      </ComboboxTrigger>
      <ComboboxContent
        label="Label name"
        placeholder="Find or create a label…"
        shouldFilter={false}
        status={status}
        emptyMessage={canCreate ? null : "Type a name to create a label"}
        inputProps={{
          "aria-invalid": canCreate && tooLong,
          "aria-describedby": "task-label-length",
        }}
        className="w-64"
        panel={manage ? manageList : undefined}
        footer={
          <>
            {!manage && canCreate && (
              <div className="shrink-0 px-2 pb-2">
                <p
                  id="task-label-length"
                  role={tooLong ? "alert" : undefined}
                  className={`px-1 pb-1 text-body-sm ${tooLong ? "text-danger" : "text-muted-foreground"}`}
                >
                  {tooLong
                    ? `Use ${TASK_LABEL_NAME_MAX_LENGTH} characters or fewer`
                    : `${name.trim().length}/${TASK_LABEL_NAME_MAX_LENGTH} characters`}
                </p>
                <ColorPicker
                  value={color}
                  onChange={setColor}
                  disabled={disabled || visibility.isPending}
                  label="Label color"
                />
                <Button
                  size="sm"
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
                  className="mt-1 w-full min-w-0 justify-start text-body-sm"
                  onClick={() => {
                    toggle({ name: name.trim(), color });
                    setName("");
                  }}
                >
                  <Plus />
                  <span className="shrink-0">Create</span>
                  <span className="min-w-0 truncate">“{name.trim()}”</span>
                </Button>
              </div>
            )}
            {isError && !data && (
              <Button
                size="xs"
                type="button"
                variant="ghost"
                className="mx-2 mb-1 shrink-0 self-start"
                onClick={() => void refetch()}
              >
                Retry
              </Button>
            )}
            {visibility.error && (
              <FieldError className="px-3 pb-2">
                Couldn’t update the label. {failureHint(visibility.error)}
              </FieldError>
            )}
            <div className="flex min-h-8 shrink-0 items-center border-t border-border-subtle bg-surface-subtle px-2">
              <Button
                size="xs"
                type="button"
                variant="ghost"
                aria-label={manage ? "Back to label picker" : "Manage labels"}
                className="w-full justify-start text-label-sm"
                onClick={() => {
                  setManage(!manage);
                  setName("");
                }}
              >
                {manage ? (
                  <>
                    <ArrowLeft aria-hidden="true" />
                    Back
                  </>
                ) : (
                  <>
                    <Settings aria-hidden="true" />
                    Manage
                  </>
                )}
              </Button>
            </div>
          </>
        }
      >
        {matching.map((label) => (
          <ComboboxItem
            key={label.name}
            value={label.name}
            aria-label={label.name}
            aria-description={
              selected(label) ? "Applied to task" : "Not applied"
            }
            keepOpen
            selected={selected(label)}
            disabled={
              disabled ||
              visibility.isPending ||
              (!selected(label) && value.length >= 20)
            }
            onSelect={() => toggle(label)}
            className="min-h-8"
          >
            <TaskLabelBadge label={label} />
            {isHidden(label) && (
              <EyeOff
                className="h-3 w-3 shrink-0 text-muted-foreground"
                aria-label="Hidden from future choices"
              />
            )}
          </ComboboxItem>
        ))}
        {hiddenMatch && !selected(hiddenMatch) && (
          <ComboboxItem
            value={hiddenMatch.name}
            aria-label={`Restore and add ${hiddenMatch.name}`}
            keepOpen
            disabled={disabled || visibility.isPending || value.length >= 20}
            onSelect={() => {
              void restoreAndAdd(hiddenMatch);
            }}
            className="min-h-9"
          >
            <TaskLabelBadge label={hiddenMatch} />
            <span className="ml-auto shrink-0 text-label-xs text-muted-foreground">
              Hidden · Restore &amp; add
            </span>
          </ComboboxItem>
        )}
      </ComboboxContent>
    </Combobox>
  );
}
