import { useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { toast } from "@/components/ui/toast";
import { MoreHorizontal } from "lucide-react";
import type { TaskBoard, TaskColumn } from "@/hooks/use-tasks";
import { useTaskActions } from "@/hooks/use-tasks";
import {
  ActionMenu,
  ActionMenuContent,
  ActionMenuItem,
  ActionMenuSeparator,
  ActionMenuTrigger,
} from "@/components/ui/action-menu";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";
import { MENU_ITEM, orderedColumns } from "./task-utils";
import { TaskCapacityDialog } from "./task-column-capacity";
import { TaskTriggerDialog } from "./task-trigger-dialog";
import { TaskColumnNameDialog } from "./task-column-name-dialog";

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
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const actions = useTaskActions(projectId);
  const [capacityOpen, setCapacityOpen] = useState(false);
  const [triggerOpen, setTriggerOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const index = columns.findIndex((item) => item.id === column.id);
  const [earlier, later] =
    orientation === "horizontal"
      ? ["Move left", "Move right"]
      : ["Move up", "Move down"];
  const reposition = (position: number) =>
    void actions.updateColumn
      .mutateAsync({ id: column.id, position })
      .catch((error: unknown) =>
        toast.error(`Couldn’t move “${column.name}”.`, { error })
      );
  return (
    <>
      <ActionMenu label="Column actions">
        <ActionMenuTrigger asChild>
          <IconButton
            ref={menuButton}
            size="icon-sm"
            label={`${column.name} menu`}
          >
            <MoreHorizontal aria-hidden="true" />
          </IconButton>
        </ActionMenuTrigger>
        <ActionMenuContent align="end">
          <ActionMenuItem
            className={MENU_ITEM}
            onSelect={() => setRenameOpen(true)}
          >
            Rename…
          </ActionMenuItem>
          <ActionMenuItem
            className={MENU_ITEM}
            onSelect={() => setTriggerOpen(true)}
          >
            {column.trigger ? "Edit trigger…" : "Add trigger…"}
          </ActionMenuItem>
          <ActionMenuItem
            className={MENU_ITEM}
            onSelect={() => setCapacityOpen(true)}
          >
            {column.capacity != null ? "Edit capacity…" : "Set capacity…"}
          </ActionMenuItem>
          <ActionMenuItem
            className={MENU_ITEM}
            disabled={index === 0}
            onSelect={() =>
              reposition(
                index > 1
                  ? (columns[index - 2].position +
                      columns[index - 1].position) /
                      2
                  : columns[0].position - 1
              )
            }
          >
            {earlier}
          </ActionMenuItem>
          <ActionMenuItem
            className={MENU_ITEM}
            disabled={index === columns.length - 1}
            onSelect={() =>
              reposition(
                index < columns.length - 2
                  ? (columns[index + 1].position +
                      columns[index + 2].position) /
                      2
                  : columns[columns.length - 1].position + 1
              )
            }
          >
            {later}
          </ActionMenuItem>
          {column.isDone && (
            <ActionMenuItem
              className={MENU_ITEM}
              disabled={archiveCount === 0}
              onSelect={() => setArchiveOpen(true)}
            >
              {archiveLabel}
            </ActionMenuItem>
          )}
          <ActionMenuSeparator />
          <ActionMenuItem
            className={cn(MENU_ITEM, "text-danger")}
            disabled={taskCount > 0}
            onSelect={() => setDeleteOpen(true)}
          >
            {taskCount > 0 ? "Delete (empty it first)" : "Delete"}
          </ActionMenuItem>
        </ActionMenuContent>
      </ActionMenu>
      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        returnFocus={menuButton}
        tone="primary"
        title={`${archiveLabel} from ${column.name}?`}
        description="Archived tasks leave the board. You can restore them from Archived."
        confirmLabel={archiveLabel}
        confirmDisabled={archiveCount === 0}
        errorTitle="Couldn’t archive the tasks."
        onConfirm={async () => {
          const result = await actions.archiveColumn.mutateAsync(column.id);
          const count = result?.archived ?? archiveCount;
          toast.success(`${count} ${count === 1 ? "task" : "tasks"} archived.`);
        }}
      />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        returnFocus={menuButton}
        title={`Delete “${column.name}”?`}
        description="The column and its trigger are removed from this board. This cannot be undone."
        confirmLabel="Delete column"
        errorTitle="Couldn’t delete the column."
        onConfirm={async () => {
          await actions.removeColumn.mutateAsync(column.id);
          toast.success(`Column “${column.name}” deleted.`);
        }}
      />
      {renameOpen && (
        <TaskColumnNameDialog
          name={column.name}
          returnFocus={menuButton}
          onClose={() => setRenameOpen(false)}
          onSave={(name) =>
            actions.updateColumn.mutateAsync({ id: column.id, name })
          }
        />
      )}
      {capacityOpen && (
        <TaskCapacityDialog
          column={column}
          projectId={projectId}
          onClose={() => setCapacityOpen(false)}
          returnFocus={menuButton}
        />
      )}
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
