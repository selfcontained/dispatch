import { useTaskDrawerTarget } from "./use-task-drawer-target";
import { useMemo } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useTaskBoard, useTaskDetail } from "@/hooks/use-tasks";
import type { Agent } from "@/components/app/types";
import { SheetHeader } from "@/components/ui/sheet";
import { TaskDrawerShell, TaskDetailPanel } from "./task-drawer";
import {
  TASK_MODAL_STATE,
  TASK_PANE_PARAM,
  orderedColumns,
} from "./task-utils";
import { useMoveTask } from "./use-move-task";
import { AsyncBoundary, combineResults } from "@/components/ui/async-boundary";
import { EmptyState } from "@/components/ui/empty-state";

/** An agent's task row switches the task rather than closing it. */
const SWITCHES_TASK = '[aria-haspopup="dialog"][aria-label^="Task: "]';

/**
 * The task named by `?task=` as a sheet beside the current view, so reading
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
  const target = useTaskDrawerTarget(id);
  const taskQuery = useTaskDetail(target);
  const task = taskQuery.data;
  const projectId = task?.projectId ?? null;
  const boardQuery = useTaskBoard(projectId);
  const board = boardQuery.data;
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
  // A press outside may be on a link, and popping history would race the
  // navigation it starts, so that way out drops the param in place.
  const dismiss = () => {
    const updated = new URLSearchParams(params);
    updated.delete("task");
    updated.delete(TASK_PANE_PARAM);
    // At once, so the pressed control sees the URL without the task.
    setParams(updated, { replace: true, flushSync: true });
  };
  const loading = combineResults(taskQuery, boardQuery);
  return (
    <>
      <TaskDrawerShell
        open={Boolean(id)}
        isMobile={isMobile}
        close={close}
        onOutsidePress={dismiss}
        dialog
        autoFocus
        label={task?.title ?? "Task"}
        keepOpen={SWITCHES_TASK}
      >
        {target ? (
          <div
            data-testid="task-modal"
            className="flex h-full min-h-0 flex-col overflow-hidden"
            aria-hidden={!id || undefined}
            {...(!id ? { inert: "" } : {})}
          >
            {projectId && board ? (
              <TaskDetailPanel
                id={target}
                active={Boolean(id)}
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
                <SheetHeader title={id ?? "Task"} onClose={close} />
                <AsyncBoundary
                  query={loading}
                  thing="the task"
                  className="m-4"
                  notFound={
                    <EmptyState
                      title="Task not found"
                      description="It may have been deleted, or the link may be wrong."
                    />
                  }
                >
                  {() => null}
                </AsyncBoundary>
              </>
            )}
          </div>
        ) : null}
      </TaskDrawerShell>
      {dialog}
    </>
  );
}
