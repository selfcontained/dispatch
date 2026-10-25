import { useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { MoreHorizontal } from "lucide-react";
import type { TaskBoard, TaskColumn } from "@/hooks/use-tasks";
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
import { MENU_ITEM, orderedColumns } from "./task-utils";
import { TaskTriggerDialog } from "./task-trigger-dialog";

/**
 * A column's `…` menu, shared by the board's column header and the list's
 * group header: rename, trigger, reorder, delete. The board lays columns
 * out sideways and the list stacks them, so only the move labels differ.
 * Order and emptiness come from the whole board, not the filtered view: a
 * search that hides a column's tasks does not make it deletable.
 */
export function TaskColumnMenu({
  column,
  board,
  orientation,
}: {
  column: TaskColumn;
  board: TaskBoard;
  orientation: "horizontal" | "vertical";
}) {
  const { projectId } = board;
  const columns = orderedColumns(board);
  const taskCount = board.tasks.filter(
    (task) => task.columnId === column.id
  ).length;
  const archiveCount = board.tasks.filter(
    (task) => task.columnId === column.id && !task.archivedAt
  ).length;
  const archiveLabel = `Archive ${archiveCount} ${archiveCount === 1 ? "task" : "tasks"}`;
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const actions = useTaskActions(projectId);
  const [triggerOpen, setTriggerOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
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
            ref={menuButton}
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
          {column.isDone && (
            <DropdownMenuItem
              className={MENU_ITEM}
              disabled={archiveCount === 0}
              onSelect={() => {
                setArchiveError(null);
                setArchiveOpen(true);
              }}
            >
              {archiveLabel}
            </DropdownMenuItem>
          )}
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
      <AlertDialog open={archiveOpen} onOpenChange={setArchiveOpen}>
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            menuButton.current?.focus();
          }}
        >
          <AlertDialogTitle className="text-lg font-semibold">
            {archiveLabel} from {column.name}?
          </AlertDialogTitle>
          <AlertDialogDescription className="text-sm text-muted-foreground">
            Archived tasks leave the board. You can restore them from Archived.
          </AlertDialogDescription>
          {archiveError && (
            <p role="alert" className="text-sm text-destructive">
              {archiveError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <AlertDialogCancel disabled={actions.archiveColumn?.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={actions.archiveColumn?.isPending || archiveCount === 0}
              onClick={(event) => {
                event.preventDefault();
                void actions.archiveColumn
                  .mutateAsync(column.id)
                  .then(() => setArchiveOpen(false))
                  .catch((error: Error) => setArchiveError(error.message));
              }}
            >
              {archiveLabel}
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>
      <TaskTriggerDialog
        column={column}
        projectId={projectId}
        open={triggerOpen}
        onOpenChange={setTriggerOpen}
        returnFocus={menuButton}
      />
    </>
  );
}
