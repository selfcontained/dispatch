import { useId, useState, type RefObject } from "react";
import type { TaskColumn } from "@/hooks/use-tasks";
import { useTaskActions } from "@/hooks/use-tasks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/** Occupancy always comes from the server, including filtered/archived views. */
export function ColumnCapacity({ column }: { column: TaskColumn }) {
  const count = column.activeTaskCount;
  const limited = column.capacity != null;
  const state =
    limited && count >= column.capacity!
      ? count > column.capacity!
        ? "Over limit"
        : "Full"
      : null;
  return (
    <span
      data-testid={`column-capacity-${column.key}`}
      aria-label={`${column.name}: ${count} active tasks${limited ? `, limit ${column.capacity}` : ", unlimited"}${state ? `, ${state}` : ""}`}
      title="All active tasks, including tasks hidden by filters. Archived tasks do not use capacity."
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full bg-background/50 px-1.5 text-xs font-normal tabular-nums text-muted-foreground",
        state && "bg-destructive/10 text-destructive"
      )}
    >
      <span>
        {count}
        {limited ? ` / ${column.capacity}` : ""}
      </span>
      {state && <span className="text-[10px]">{state}</span>}
    </span>
  );
}

/** Mounted on open so edits stay local and reopening reads the saved value. */
export function TaskCapacityDialog({
  column,
  projectId,
  onClose,
  returnFocus,
}: {
  column: TaskColumn;
  projectId: string;
  onClose: () => void;
  returnFocus: RefObject<HTMLElement | null>;
}) {
  const id = useId();
  const [value, setValue] = useState(column.capacity?.toString() ?? "");
  const [error, setError] = useState<string | null>(null);
  const actions = useTaskActions(projectId);
  const pending = actions.updateColumn.isPending;
  const save = async (capacity: number | null) => {
    setError(null);
    try {
      await actions.updateColumn.mutateAsync({ id: column.id, capacity });
      onClose();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not save capacity."
      );
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Capacity · {column.name}</DialogTitle>
          <DialogDescription>
            Limit active tasks entering this column. Archived tasks do not
            count. Existing tasks can stay when you lower the limit.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (!value.trim()) {
              void save(null);
              return;
            }
            const capacity = Number(value);
            if (
              !/^\d+$/.test(value) ||
              !Number.isInteger(capacity) ||
              capacity < 1 ||
              capacity > 2147483647
            ) {
              setError(
                "Enter a whole number from 1 to 2147483647, or leave blank for unlimited."
              );
              return;
            }
            void save(capacity);
          }}
        >
          <div className="space-y-2">
            <label htmlFor={id} className="text-sm font-medium">
              Active task limit
            </label>
            <Input
              id={id}
              type="number"
              inputMode="numeric"
              min={1}
              max={2147483647}
              step={1}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="Unlimited"
              disabled={pending}
              aria-invalid={!!error}
              aria-describedby={`${id}-help${error ? ` ${id}-error` : ""}`}
            />
            <p id={`${id}-help`} className="text-xs text-muted-foreground">
              {column.activeTaskCount} active tasks now. Leave blank for
              unlimited. Capacity only gates entry here; an earlier trigger
              reserves no future slot.
            </p>
          </div>
          {error && (
            <p
              id={`${id}-error`}
              role="alert"
              className="text-sm text-destructive"
            >
              {error}
            </p>
          )}
          <div className="flex flex-wrap justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={pending || column.capacity == null}
              onClick={() => void save(null)}
            >
              Remove limit
            </Button>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={onClose}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
