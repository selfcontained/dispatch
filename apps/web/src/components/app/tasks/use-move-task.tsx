import { useState } from "react";
import type { Task, TaskBoard } from "@/hooks/use-tasks";
import { useTaskActions } from "@/hooks/use-tasks";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { toast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api";
import { tasksInColumn } from "./task-utils";

/**
 * Move a task on its board. A move the server refuses because the assignee
 * is still working asks first, then moves and launches; render `dialog`.
 */
export function useMoveTask(projectId: string, board: TaskBoard | undefined) {
  const actions = useTaskActions(projectId);
  const [relaunch, setRelaunch] = useState<{
    task: Task;
    columnId: string;
    beforeId: string | null;
  } | null>(null);
  const moveTask = async (task: Task, columnId: string, beforeId?: string) => {
    if (!board || task.id === beforeId) return;
    const ordered = tasksInColumn(board.tasks, columnId);
    if (
      task.columnId === columnId &&
      ordered[ordered.findIndex((item) => item.id === task.id) + 1]?.id ===
        beforeId
    )
      return;
    try {
      await actions.update.mutateAsync({
        id: task.id,
        columnId,
        beforeId: beforeId ?? null,
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === "agent_working")
        setRelaunch({ task, columnId, beforeId: beforeId ?? null });
      // The card is back where it was, and the drag is over.
      else toast.error(`Couldn’t move “${task.title}”.`, { error });
    }
  };
  const dialog = (
    <ConfirmDialog
      open={!!relaunch}
      onOpenChange={(open) => {
        if (!open) setRelaunch(null);
      }}
      tone="primary"
      title="Launch another agent?"
      description="The assigned agent is still working on this task. Moving it here will launch another agent."
      confirmLabel="Move and launch"
      errorTitle="Couldn’t move the task."
      onConfirm={async () => {
        if (!relaunch) return;
        await actions.update.mutateAsync({
          id: relaunch.task.id,
          columnId: relaunch.columnId,
          beforeId: relaunch.beforeId,
          confirmRelaunch: true,
        });
      }}
    />
  );
  return { moveTask, dialog };
}
