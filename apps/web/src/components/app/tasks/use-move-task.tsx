import {
  TaskLaunchPreviewView,
  useTaskLaunchPreview,
} from "./task-launch-template";
import { useState } from "react";
import type { Task, TaskBoard } from "@/hooks/use-tasks";
import { useTaskActions } from "@/hooks/use-tasks";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApiError } from "@/lib/api";
import { tasksInColumn } from "./task-utils";

/**
 * Move a task on its board. A move the server refuses because the assignee
 * is still working asks first, then moves and launches; render `dialog`.
 */
export function useMoveTask(projectId: string, board: TaskBoard | undefined) {
  const actions = useTaskActions(projectId);
  const [previewMove, setPreviewMove] = useState<{
    task: Task;
    columnId: string;
    beforeId?: string;
  } | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [relaunch, setRelaunch] = useState<{
    task: Task;
    columnId: string;
    beforeId: string | null;
  } | null>(null);
  const applyMove = async (task: Task, columnId: string, beforeId?: string) => {
    if (!board || task.id === beforeId) return;
    setMoveError(null);
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
      else
        setMoveError(
          error instanceof Error ? error.message : "Could not move task."
        );
    }
  };
  const moveTask = async (task: Task, columnId: string, beforeId?: string) => {
    if (
      task.columnId !== columnId &&
      task.launchTemplates?.[columnId] &&
      board?.columns.find((c) => c.id === columnId)?.trigger
    ) {
      setPreviewMove({ task, columnId, beforeId });
      return;
    }
    await applyMove(task, columnId, beforeId);
  };
  const dialog = (
    <Dialog
      open={!!relaunch || !!moveError || !!previewMove}
      onOpenChange={(open) => {
        if (!open) {
          setPreviewMove(null);
          setRelaunch(null);
          setMoveError(null);
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {moveError
              ? "Could not move task"
              : previewMove
                ? "Move and launch task template?"
                : "Launch another agent?"}
          </DialogTitle>
          <DialogDescription>
            {moveError ??
              (previewMove
                ? "Entering this stage uses the task's selected launch template."
                : "The assigned agent is still working on this task. Moving it here will launch another agent.")}
          </DialogDescription>
        </DialogHeader>

        {previewMove && !moveError && (
          <MoveLaunchPreview
            projectId={projectId}
            task={previewMove.task}
            columnId={previewMove.columnId}
            onCancel={() => setPreviewMove(null)}
            onConfirm={() => {
              const move = previewMove;
              setPreviewMove(null);
              void applyMove(move.task, move.columnId, move.beforeId);
            }}
          />
        )}
        {(!previewMove || moveError) && (
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setPreviewMove(null);
                setRelaunch(null);
                setMoveError(null);
              }}
            >
              {moveError ? "Close" : "Cancel"}
            </Button>
            {relaunch && !moveError && (
              <Button
                disabled={actions.update.isPending}
                onClick={() => {
                  if (relaunch)
                    void actions.update
                      .mutateAsync({
                        id: relaunch.task.id,
                        columnId: relaunch.columnId,
                        beforeId: relaunch.beforeId,
                        confirmRelaunch: true,
                      })
                      .catch((error: Error) => setMoveError(error.message))
                      .finally(() => setRelaunch(null));
                }}
              >
                Move and launch
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
  return { moveTask, dialog };
}

function MoveLaunchPreview({
  projectId,
  task,
  columnId,
  onConfirm,
  onCancel,
}: {
  projectId: string;
  task: Task;
  columnId: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const preview = useTaskLaunchPreview(
    projectId,
    columnId,
    task.launchTemplates?.[columnId] ?? null
  );
  return (
    <div className="space-y-3">
      {preview.isFetching ? (
        <p role="status">Loading launch preview…</p>
      ) : preview.data ? (
        <TaskLaunchPreviewView preview={preview.data} />
      ) : (
        <p role="alert">Could not load launch preview.</p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          disabled={preview.isFetching || !preview.data?.available}
          onClick={onConfirm}
        >
          Move and launch
        </Button>
      </div>
    </div>
  );
}
