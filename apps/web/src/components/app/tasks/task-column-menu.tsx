import { useState } from "react";
import { MoreHorizontal } from "lucide-react";
import type { TaskColumn } from "@/hooks/use-tasks";
import { useTaskActions } from "@/hooks/use-tasks";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { MENU_ITEM } from "./task-utils";
import { TaskTriggerDialog } from "./task-trigger-dialog";

/**
 * A column's `…` menu, shared by the board's column header and the list's
 * group header: rename, trigger, reorder, delete. The board lays columns
 * out sideways and the list stacks them, so only the move labels differ.
 */
export function TaskColumnMenu({
  column,
  columns,
  projectId,
  taskCount,
  orientation,
}: {
  column: TaskColumn;
  /** Every column of the board, in order. */
  columns: TaskColumn[];
  projectId: string;
  taskCount: number;
  orientation: "horizontal" | "vertical";
}) {
  const actions = useTaskActions(projectId);
  const [triggerOpen, setTriggerOpen] = useState(false);
  const index = columns.findIndex((item) => item.id === column.id);
  const [earlier, later] =
    orientation === "horizontal"
      ? ["Move left", "Move right"]
      : ["Move up", "Move down"];
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            aria-label={`${column.name} menu`}
            className="h-7 w-7 text-muted-foreground"
          >
            <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            className={MENU_ITEM}
            onSelect={() => {
              const name = window.prompt("Column name", column.name);
              if (name?.trim())
                void actions.updateColumn.mutateAsync({
                  id: column.id,
                  name: name.trim(),
                });
            }}
          >
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            className={MENU_ITEM}
            onSelect={() => setTriggerOpen(true)}
          >
            {column.trigger ? "Edit trigger…" : "Add trigger…"}
          </DropdownMenuItem>
          <DropdownMenuItem
            className={MENU_ITEM}
            disabled={index === 0}
            onSelect={() =>
              void actions.updateColumn.mutateAsync({
                id: column.id,
                position:
                  index > 1
                    ? (columns[index - 2].position +
                        columns[index - 1].position) /
                      2
                    : columns[0].position - 1,
              })
            }
          >
            {earlier}
          </DropdownMenuItem>
          <DropdownMenuItem
            className={MENU_ITEM}
            disabled={index === columns.length - 1}
            onSelect={() =>
              void actions.updateColumn.mutateAsync({
                id: column.id,
                position:
                  index < columns.length - 2
                    ? (columns[index + 1].position +
                        columns[index + 2].position) /
                      2
                    : columns[columns.length - 1].position + 1,
              })
            }
          >
            {later}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className={cn(MENU_ITEM, "text-destructive")}
            disabled={taskCount > 0}
            onSelect={() => {
              if (window.confirm(`Delete ${column.name}?`))
                void actions.removeColumn.mutateAsync(column.id);
            }}
          >
            {taskCount > 0 ? "Delete (empty it first)" : "Delete"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <TaskTriggerDialog
        column={column}
        projectId={projectId}
        open={triggerOpen}
        onOpenChange={setTriggerOpen}
      />
    </>
  );
}
