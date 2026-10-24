import { useMemo } from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { useTaskBoard, useTaskDetail } from "@/hooks/use-tasks";
import type { Agent } from "@/components/app/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { TaskDetailPanel } from "./task-drawer";
import { TASK_DIALOG_MOBILE_SHEET } from "./task-create-dialog";
import { TASK_MODAL_STATE, orderedColumns } from "./task-utils";
import { useMoveTask } from "./use-move-task";

/**
 * The task named by `?task=` as a modal over the current view, so reading
 * it never leaves the stream. Closing drops the param and nothing else.
 */
export function TaskModal({
  agents,
  isMobile,
}: {
  agents: Agent[];
  isMobile: boolean;
}) {
  const [params, setParams] = useSearchParams();
  const id = params.get("task");
  const { data: task, error } = useTaskDetail(id);
  const projectId = task?.projectId ?? null;
  const { data: board } = useTaskBoard(projectId);
  const columns = useMemo(() => (board ? orderedColumns(board) : []), [board]);
  const { moveTask, dialog } = useMoveTask(projectId ?? "", board);
  const location = useLocation();
  const navigate = useNavigate();
  // Paging between tasks replaces the entry; closing pops the one opening
  // pushed, so Back after closing leaves rather than reopening. A deep link
  // has no such entry and drops the param in place.
  const setTask = (next: string | null) => {
    const state = location.state as typeof TASK_MODAL_STATE | null;
    if (!next && state?.taskModal) return navigate(-1);
    const updated = new URLSearchParams(params);
    if (next) updated.set("task", next);
    else updated.delete("task");
    setParams(updated, { replace: true, state: location.state });
  };
  return (
    <>
      <Dialog
        open={Boolean(id)}
        onOpenChange={(open) => {
          if (!open) setTask(null);
        }}
      >
        <DialogContent
          data-testid="task-modal"
          className={`h-[min(860px,calc(100dvh-4rem))] max-h-none gap-0 bg-background p-0 md:w-[min(720px,calc(100vw-2rem))] ${TASK_DIALOG_MOBILE_SHEET}`}
        >
          <DialogTitle className="sr-only">{task?.title ?? "Task"}</DialogTitle>
          <DialogDescription className="sr-only">
            The task, over the stream you were reading.
          </DialogDescription>
          {id && projectId && board ? (
            <TaskDetailPanel
              id={id}
              projectId={projectId}
              columns={columns}
              boardTasks={board.tasks}
              agents={agents}
              close={() => setTask(null)}
              openTask={setTask}
              moveTask={moveTask}
              isMobile={isMobile}
              headerAction={
                <Link
                  to={`/tasks?task=${encodeURIComponent(id)}&project=${encodeURIComponent(projectId)}`}
                  className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-primary hover:bg-muted"
                >
                  Open in Tasks
                  <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                </Link>
              }
            />
          ) : error ? (
            <p className="p-5 text-sm text-destructive">
              Could not load the task: {error.message}
            </p>
          ) : (
            <p className="p-5 text-sm text-muted-foreground">Loading task…</p>
          )}
        </DialogContent>
      </Dialog>
      {dialog}
    </>
  );
}
