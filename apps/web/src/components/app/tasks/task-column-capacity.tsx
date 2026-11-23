import { useState, type RefObject } from "react";
import type { TaskColumn } from "@/hooks/use-tasks";
import { useTaskActions } from "@/hooks/use-tasks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogBody,
  DialogCancel,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Hint } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { Field } from "@/components/ui/field";

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
    <Hint label="All active tasks, including tasks hidden by filters. Archived tasks do not use capacity.">
      <Badge
        size="sm"
        tone={state === "Over limit" ? "danger" : state ? "warning" : "neutral"}
        data-testid={`column-capacity-${column.key}`}
        aria-label={`${column.name}: ${count} active tasks${limited ? `, limit ${column.capacity}` : ", unlimited"}${state ? `, ${state}` : ""}`}
        className="tabular-nums"
      >
        <span>
          {count}
          {limited ? ` / ${column.capacity}` : ""}
        </span>
        {state && <span>{state}</span>}
      </Badge>
    </Hint>
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
  const [value, setValue] = useState(column.capacity?.toString() ?? "");
  const [invalid, setInvalid] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>();
  const actions = useTaskActions(projectId);
  const pending = actions.updateColumn.isPending;
  const save = async (capacity: number | null) => {
    setInvalid(null);
    setFailure(undefined);
    try {
      await actions.updateColumn.mutateAsync({ id: column.id, capacity });
      onClose();
    } catch (error) {
      setFailure(error);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        busy={pending}
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
        <DialogForm
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
              setFailure(undefined);
              setInvalid(
                "Enter a whole number from 1 to 2147483647, or leave blank for unlimited."
              );
              return;
            }
            void save(capacity);
          }}
        >
          <DialogBody>
            <Field
              label="Active task limit"
              error={invalid}
              hint={`${column.activeTaskCount} active tasks now. Leave blank for unlimited. Capacity only gates entry here; an earlier trigger reserves no future slot.`}
            >
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={2147483647}
                step={1}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder="Unlimited"
                disabled={pending}
              />
            </Field>
          </DialogBody>
          {failure ? (
            <Alert title="Couldn’t save the capacity." error={failure} />
          ) : null}
          <DialogFooter
            start={
              <Button
                type="button"
                variant="ghost"
                disabled={pending || column.capacity == null}
                onClick={() => void save(null)}
              >
                Remove limit
              </Button>
            }
          >
            <DialogCancel />
            <Button type="submit" variant="primary" pending={pending}>
              Save capacity
            </Button>
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}
