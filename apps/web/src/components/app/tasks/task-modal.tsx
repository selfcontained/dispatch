import { useMemo, useRef } from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { ArrowLeft, ArrowUpRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import {
  TASK_MODAL_STATE,
  TASK_PANE_PARAM,
  orderedColumns,
} from "./task-utils";
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
  const taskQuery = useTaskDetail(id);
  const task = taskQuery.data;
  const projectId = task?.projectId ?? null;
  const boardQuery = useTaskBoard(projectId);
  const board = boardQuery.data;
  const contentRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
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
    if (next) {
      updated.set("task", next);
      // Preserve the underlying agent's block/thread without carrying its
      // implicit Conversation selection into an ordinary task switch.
      updated.set(TASK_PANE_PARAM, "details");
    } else {
      updated.delete("task");
      updated.delete(TASK_PANE_PARAM);
    }
    setParams(updated, { replace: true, state: location.state });
  };
  const close = () => setTask(null);
  const loadError = taskQuery.error
    ? `Could not load the task: ${taskQuery.error.message}`
    : boardQuery.error
      ? `Could not load the task's board: ${boardQuery.error.message}`
      : null;
  const openInTasks = id ? (
    <Link
      to={`/tasks?task=${encodeURIComponent(id)}${projectId ? `&project=${encodeURIComponent(projectId)}` : ""}`}
      className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-primary hover:bg-muted"
    >
      Open in Tasks
      <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
    </Link>
  ) : null;
  return (
    <>
      <Dialog
        open={Boolean(id)}
        onOpenChange={(open) => {
          if (!open) setTask(null);
        }}
      >
        <DialogContent
          ref={contentRef}
          data-testid="task-modal"
          onOpenAutoFocus={() => {
            openerRef.current =
              document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
          }}
          onCloseAutoFocus={(event) => {
            if (openerRef.current?.isConnected) {
              event.preventDefault();
              openerRef.current.focus({ preventScroll: true });
            }
          }}
          // An attachment preview inside the conversation closes on Escape
          // itself; Radix sees the key first and would close the task.
          onEscapeKeyDown={(event) => {
            if (
              contentRef.current?.querySelector('[data-testid="file-lightbox"]')
            )
              event.preventDefault();
          }}
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
              close={close}
              openTask={setTask}
              moveTask={moveTask}
              isMobile={isMobile}
              headerAction={openInTasks}
            />
          ) : (
            <>
              {/* The panel's header waits on both queries; until then this
                  one keeps a way out, which a phone has no overlay for. */}
              <header className="flex shrink-0 items-center gap-1 border-b border-border/40 bg-card/60 px-2 py-1.5 pt-[max(0.375rem,env(safe-area-inset-top))] text-xs text-muted-foreground">
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={close}
                  aria-label="Close task"
                  className="md:hidden"
                >
                  <ArrowLeft className="h-4 w-4" />
                </Button>
                <span className="min-w-0 flex-1 truncate px-1 font-mono">
                  {id}
                </span>
                {openInTasks}
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={close}
                  aria-label="Close task"
                  className="hidden md:inline-flex"
                >
                  <X className="h-4 w-4" />
                </Button>
              </header>
              {loadError ? (
                <div
                  role="alert"
                  className="flex items-center justify-between gap-3 p-5 text-sm text-destructive"
                >
                  <span className="min-w-0">{loadError}</span>
                  <Button
                    size="sm"
                    className="shrink-0"
                    onClick={() => {
                      void (taskQuery.error
                        ? taskQuery.refetch()
                        : boardQuery.refetch());
                    }}
                  >
                    Retry
                  </Button>
                </div>
              ) : (
                <p className="p-5 text-sm text-muted-foreground">
                  Loading task…
                </p>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
      {dialog}
    </>
  );
}
