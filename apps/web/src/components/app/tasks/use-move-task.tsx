import { useState } from "react";
import type { Task, TaskBoard } from "@/hooks/use-tasks";
import { useTaskActions } from "@/hooks/use-tasks";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApiError } from "@/lib/api";
import { nextPosition } from "./task-utils";

/**
 * Move a task on its board. A move the server refuses because the assignee
 * is still working asks first, then moves and launches; render `dialog`.
 */
export function useMoveTask(projectId: string, board: TaskBoard | undefined) {
  const actions = useTaskActions(projectId);
  const [relaunch, setRelaunch] = useState<{
    task: Task;
    columnId: string;
    position: number;
  } | null>(null);
  const moveTask = async (task: Task, columnId: string, beforeId?: string) => {
    if (!board || task.id === beforeId) return;
    const position = nextPosition(board.tasks, columnId, beforeId);
    try {
      await actions.update.mutateAsync({ id: task.id, columnId, position });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409)
        setRelaunch({ task, columnId, position });
    }
  };
  const dialog = (
    <Dialog
      open={!!relaunch}
      onOpenChange={(open) => {
        if (!open) setRelaunch(null);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Launch another agent?</DialogTitle>
        </DialogHeader>
        <p className="text-sm">
          The assigned agent is still working on this task. Moving it here will
          launch another agent.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setRelaunch(null)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (relaunch)
                void actions.update
                  .mutateAsync({
                    id: relaunch.task.id,
                    columnId: relaunch.columnId,
                    position: relaunch.position,
                    confirmRelaunch: true,
                  })
                  .finally(() => setRelaunch(null));
            }}
          >
            Move and launch
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
  return { moveTask, dialog };
}
