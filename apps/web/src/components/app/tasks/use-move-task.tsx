import {
  TaskLaunchPreviewView,
  useTaskLaunchPreview,
} from "./task-launch-template";
import { useState } from "react";
import type { Task, TaskBoard, TaskColumn } from "@/hooks/use-tasks";
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
    taskId: string;
    columnId: string;
    beforeId?: string;
  } | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [relaunch, setRelaunch] = useState<{
    taskId: string;
    columnId: string;
    beforeId: string | null;
    expectedLaunchRevision?: string;
  } | null>(null);
  const currentPreviewTask = board?.tasks.find(
    (task) => task.id === previewMove?.taskId
  );
  const previewColumn = board?.columns?.find(
    (column) => column.id === previewMove?.columnId
  );
  const applyMove = async (
    task: Task,
    columnId: string,
    beforeId?: string,
    expectedLaunchRevision?: string
  ) => {
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
        ...(expectedLaunchRevision ? { expectedLaunchRevision } : {}),
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === "agent_working")
        setRelaunch({
          taskId: task.id,
          columnId,
          beforeId: beforeId ?? null,
          expectedLaunchRevision,
        });
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
      setPreviewMove({ taskId: task.id, columnId, beforeId });
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

        {previewMove && !moveError && currentPreviewTask && previewColumn && (
          <MoveLaunchPreview
            projectId={projectId}
            task={currentPreviewTask}
            column={previewColumn}
            onCancel={() => setPreviewMove(null)}
            onConfirm={(revision) => {
              const move = previewMove;
              setPreviewMove(null);
              void applyMove(
                currentPreviewTask,
                move.columnId,
                move.beforeId,
                revision
              );
            }}
          />
        )}
        {previewMove &&
          !moveError &&
          (!currentPreviewTask || !previewColumn) && (
            <p role="alert">
              This task or stage is no longer available. Close and choose the
              move again.
            </p>
          )}
        {(!previewMove ||
          moveError ||
          !currentPreviewTask ||
          !previewColumn) && (
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
                        id: relaunch.taskId,
                        columnId: relaunch.columnId,
                        beforeId: relaunch.beforeId,
                        confirmRelaunch: true,
                        ...(relaunch.expectedLaunchRevision
                          ? {
                              expectedLaunchRevision:
                                relaunch.expectedLaunchRevision,
                            }
                          : {}),
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
  column,
  onConfirm,
  onCancel,
}: {
  projectId: string;
  task: Task;
  column: TaskColumn;
  onConfirm: (revision: string) => void;
  onCancel: () => void;
}) {
  const preview = useTaskLaunchPreview(
    projectId,
    column.id,
    task.launchTemplates?.[column.id] ?? null,
    `${task.updatedAt}:${column.updatedAt}`
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
          disabled={
            preview.isFetching ||
            !preview.data?.available ||
            !preview.data.revision ||
            task.columnId === column.id ||
            !!task.archivedAt
          }
          onClick={() => {
            if (preview.data?.revision) onConfirm(preview.data.revision);
          }}
        >
          Move and launch
        </Button>
      </div>
    </div>
  );
}
