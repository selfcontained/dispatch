import { Check } from "lucide-react";
import type { Task, TaskColumn } from "@/hooks/use-tasks";
import { Sheet, SheetHeader } from "@/components/ui/sheet";
import { RowButton } from "@/components/ui/row-button";
import { StatusDot } from "@/components/ui/status-dot";
import { cn } from "@/lib/utils";
import { columnAccent } from "./task-utils";

/** Move a task to another column without dragging it there. */
export function TaskMoveSheet({
  task,
  columns,
  open,
  onOpenChange,
  onMove,
  returnFocus,
}: {
  task: Task;
  columns: TaskColumn[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMove: (columnId: string) => void;
  /** Where focus goes back to on close: the sheet has no trigger. */
  returnFocus: () => void;
}) {
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      side="bottom"
      keepMounted={false}
      label="Move to…"
      returnFocus={returnFocus}
      data-testid="task-move-sheet"
    >
      <SheetHeader
        title="Move to…"
        description={task.title}
        onClose={() => onOpenChange(false)}
      />
      {/* Plain buttons, one tab stop each: a listbox would promise arrow
          keys this doesn't need. */}
      <div
        role="group"
        aria-label="Columns"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2 pb-safe-2"
      >
        {columns.map((column, index) => {
          const current = column.id === task.columnId;
          return (
            <RowButton
              key={column.id}
              className={cn(
                "min-h-11 gap-3 px-3 text-body-md",
                current && "font-medium"
              )}
              onClick={() => {
                onOpenChange(false);
                if (!current) onMove(column.id);
              }}
            >
              <StatusDot color={`hsl(${columnAccent(column, index)})`} />
              <span className="min-w-0 flex-1 truncate">{column.name}</span>
              {current && (
                <>
                  <span className="sr-only">, current column</span>
                  <Check
                    className="h-4 w-4 text-muted-foreground"
                    aria-hidden="true"
                  />
                </>
              )}
            </RowButton>
          );
        })}
      </div>
    </Sheet>
  );
}
