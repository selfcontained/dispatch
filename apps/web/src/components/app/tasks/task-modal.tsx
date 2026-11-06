import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useMemo, useRef } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTaskBoard, useTaskDetail } from "@/hooks/use-tasks";
import type { Agent } from "@/components/app/types";
import { Dialog, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { TaskDrawerShell, TaskDetailPanel } from "./task-drawer";
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
  return (
    <>
      <Dialog
        modal={false}
        open={Boolean(id)}
        onOpenChange={(open) => {
          if (!open) setTask(null);
        }}
      >
        <TaskDrawerShell open={Boolean(id)} isMobile={isMobile} close={close}>
          <DialogPrimitive.Content
            ref={contentRef}
            onInteractOutside={(event) => event.preventDefault()}
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
                contentRef.current?.querySelector(
                  '[data-testid="file-lightbox"]'
                )
              )
                event.preventDefault();
            }}
            className="flex h-full min-h-0 flex-col overflow-hidden outline-none"
          >
            <DialogTitle className="sr-only">
              {task?.title ?? "Task"}
            </DialogTitle>
            <DialogDescription className="sr-only">
              The task, beside the stream you were reading.
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
          </DialogPrimitive.Content>
        </TaskDrawerShell>
      </Dialog>
      {dialog}
    </>
  );
}
