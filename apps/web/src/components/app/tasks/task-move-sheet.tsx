import { Check } from "lucide-react";
import type { Task, TaskColumn } from "@/hooks/use-tasks";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { columnAccent } from "./task-utils";

/** A bottom sheet on a phone; a small centered dialog otherwise. */
const BOTTOM_SHEET =
  "max-md:inset-x-0 max-md:bottom-0 max-md:left-0 max-md:top-auto max-md:w-full max-md:max-h-[85dvh] max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-b-none max-md:pb-[max(1rem,env(safe-area-inset-bottom))] md:w-[min(360px,calc(100vw-2rem))]";

/** Move a task to another column without dragging it there. */
export function TaskMoveSheet({
  task,
  columns,
  open,
  onOpenChange,
  onMove,
}: {
  task: Task;
  columns: TaskColumn[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMove: (columnId: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="task-move-sheet" className={BOTTOM_SHEET}>
        <DialogHeader>
          <DialogTitle className="text-base">Move to…</DialogTitle>
          <DialogDescription className="truncate">
            {task.title}
          </DialogDescription>
        </DialogHeader>
        <div
          role="listbox"
          aria-label="Columns"
          className="-mx-1 overflow-y-auto"
        >
          {columns.map((column, index) => {
            const current = column.id === task.columnId;
            return (
              <button
                key={column.id}
                type="button"
                role="option"
                aria-selected={current}
                className={cn(
                  "flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-left text-sm hover:bg-muted/60",
                  current && "font-medium"
                )}
                onClick={() => {
                  onOpenChange(false);
                  if (!current) onMove(column.id);
                }}
              >
                <span
                  aria-hidden="true"
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ background: `hsl(${columnAccent(column, index)})` }}
                />
                <span className="min-w-0 flex-1 truncate">{column.name}</span>
                {current && (
                  <Check
                    className="h-4 w-4 text-muted-foreground"
                    aria-label="Current column"
                  />
                )}
              </button>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
