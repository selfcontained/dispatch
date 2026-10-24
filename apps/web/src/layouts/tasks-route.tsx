import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAtom } from "jotai";
import { LayoutGrid, List, Plus, Zap } from "lucide-react";
import { SectionShell } from "./section-shell";
import { ProjectSwitcher } from "@/components/app/project-switcher";
import { useDashboardContext } from "@/components/app/dashboard-context";
import { useProjectScope } from "@/hooks/use-projects";
import {
  useTaskActions,
  useTaskBoard,
  useTaskDetail,
  type Task,
} from "@/hooks/use-tasks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { taskLayoutAtomFamily } from "@/lib/store";
import { TaskBoard } from "@/components/app/tasks/task-board";
import { TaskList } from "@/components/app/tasks/task-list";
import { TaskDrawer } from "@/components/app/tasks/task-drawer";
import {
  columnAccent,
  needsAttention,
  nextPosition,
  orderedColumns,
  visibleTasks,
} from "@/components/app/tasks/task-utils";
import { ApiError } from "@/lib/api";

const ATTENTION = "__attention";
function TasksContent({ projectId }: { projectId: string }) {
  const { projects } = useProjectScope();
  const project = projects.find((item) => item.id === projectId);
  const [params, setParams] = useSearchParams();
  const { agents, isMobile, setMobileLeftOpen } = useDashboardContext();
  const { data: board, isLoading, error } = useTaskBoard(projectId);
  const actions = useTaskActions(projectId);
  const [savedLayout, setSavedLayout] = useAtom(
    taskLayoutAtomFamily(projectId)
  );
  const layout =
    params.get("layout") === "list" || params.get("layout") === "board"
      ? (params.get("layout") as "list" | "board")
      : isMobile
        ? "list"
        : savedLayout;
  const [newTask, setNewTask] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [search, setSearch] = useState("");
  const [assignee, setAssignee] = useState("all");
  const [relaunch, setRelaunch] = useState<{
    task: Task;
    columnId: string;
    position: number;
  } | null>(null);
  const columns = useMemo(() => (board ? orderedColumns(board) : []), [board]);
  const attention = new Set(
    agents
      .filter(
        (agent) => agent.activity === "blocked" || agent.activity === "waiting"
      )
      .map((agent) => agent.id)
  );
  const matchesAssignee = (task: Task) =>
    assignee === "all" ||
    (assignee === ATTENTION
      ? needsAttention(task, attention)
      : task.assignedAgentId === assignee);
  const tasks = board
    ? visibleTasks(board.tasks, columns).filter(
        (task) =>
          task.title.toLowerCase().includes(search.toLowerCase()) &&
          matchesAssignee(task)
      )
    : [];
  const attentionCount = board
    ? board.tasks.filter((task) => needsAttention(task, attention)).length
    : 0;
  const updateParam = (name: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    setParams(next);
  };
  const openTask = (id: string) => updateParam("task", id);
  const setLayout = (value: "board" | "list") => {
    setSavedLayout(value);
    updateParam("layout", value);
  };
  // On a phone the sidebar is a sheet over the board: anything picked in
  // it hands the screen back to the board.
  const leaveSidebar = () => {
    if (isMobile) setMobileLeftOpen(false);
  };
  const showColumn = (columnId: string) => {
    leaveSidebar();
    requestAnimationFrame(() =>
      document.getElementById(`task-column-${columnId}`)?.scrollIntoView({
        behavior: "smooth",
        block: "start",
        inline: "start",
      })
    );
  };
  const startNewTask = () => {
    leaveSidebar();
    setNewTask(true);
  };
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
  const saveNew = async () => {
    if (!newTitle.trim()) return;
    const task = await actions.create.mutateAsync({
      projectId,
      title: newTitle.trim(),
      columnId: columns[0]?.id,
    });
    setNewTask(false);
    setNewTitle("");
    openTask(task.id);
  };
  const sidebar = (
    <div className="space-y-5 p-3">
      <ProjectSwitcher />
      <Button className="w-full justify-start" onClick={startNewTask}>
        <Plus className="mr-2 h-4 w-4" />
        New task
      </Button>
      <div>
        <h2 className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Columns
        </h2>
        {columns.map((column, index) => (
          <button
            key={column.id}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/60"
            onClick={() => showColumn(column.id)}
          >
            <span
              aria-hidden="true"
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: `hsl(${columnAccent(column, index)})` }}
            />
            <span className="min-w-0 flex-1 truncate">{column.name}</span>
            {column.trigger && (
              <Zap
                aria-label="Automation configured"
                className="h-3.5 w-3.5 text-muted-foreground"
              />
            )}
            <span className="tabular-nums text-muted-foreground">
              {
                board?.tasks.filter((task) => task.columnId === column.id)
                  .length
              }
            </span>
          </button>
        ))}
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 w-full justify-start text-muted-foreground"
          onClick={() => {
            const name = window.prompt("New column name");
            if (name?.trim())
              void actions.createColumn.mutateAsync({ name: name.trim() });
          }}
        >
          <Plus className="mr-1 h-3.5 w-3.5" /> Add column
        </Button>
      </div>
    </div>
  );
  return (
    <SectionShell activeSection="tasks" sidebar={sidebar}>
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="flex flex-col gap-2 px-3 py-2 md:flex-row md:items-center md:px-4 md:py-3">
          <div className="flex min-w-0 items-center gap-2 md:mr-auto">
            <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">
              Tasks{" "}
              <span className="text-sm font-normal text-muted-foreground">
                · {project?.name}
              </span>
            </h1>
            <Button
              size="icon"
              variant="ghost"
              className="md:hidden"
              aria-label="New task"
              onClick={startNewTask}
            >
              <Plus className="h-4 w-4" />
            </Button>
            <div className="flex shrink-0 rounded-lg bg-muted/50 p-0.5 md:order-last">
              <Button
                size="sm"
                variant={layout === "board" ? "default" : "ghost"}
                onClick={() => setLayout("board")}
                aria-label="Board layout"
                className="h-7 px-2"
              >
                <LayoutGrid className="h-4 w-4 md:mr-1" />
                <span className="hidden md:inline">Board</span>
              </Button>
              <Button
                size="sm"
                variant={layout === "list" ? "default" : "ghost"}
                onClick={() => setLayout("list")}
                aria-label="List layout"
                className="h-7 px-2"
              >
                <List className="h-4 w-4 md:mr-1" />
                <span className="hidden md:inline">List</span>
              </Button>
            </div>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <Input
              aria-label="Search tasks"
              placeholder="Search tasks"
              className="h-8 min-w-0 flex-1 md:w-44 md:flex-none"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <Select value={assignee} onValueChange={setAssignee}>
              <SelectTrigger
                aria-label="Filter by assignee"
                className="h-8 w-40 shrink-0"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All assignees</SelectItem>
                <SelectItem value={ATTENTION}>
                  Needs attention
                  {attentionCount ? ` · ${attentionCount}` : ""}
                </SelectItem>
                {agents
                  .filter((agent) => agent.projectId === projectId)
                  .map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        </header>
        {isLoading && (
          <p className="p-5 text-sm text-muted-foreground">Loading board…</p>
        )}
        {error && (
          <p className="p-5 text-sm text-destructive">
            Could not load tasks: {error.message}
          </p>
        )}
        {board && (
          <div className="min-h-0 flex-1">
            {layout === "board" ? (
              <TaskBoard
                board={board}
                tasks={tasks}
                agents={agents}
                openTask={openTask}
                moveTask={moveTask}
              />
            ) : (
              <TaskList
                board={board}
                tasks={tasks}
                agents={agents}
                openTask={openTask}
                moveTask={moveTask}
              />
            )}
          </div>
        )}
      </div>
      {params.get("task") && board && (
        <TaskDrawer
          id={params.get("task")!}
          projectId={projectId}
          columns={columns}
          boardTasks={board.tasks}
          agents={agents}
          close={() => updateParam("task", null)}
          openTask={openTask}
          moveTask={moveTask}
          isMobile={isMobile}
        />
      )}
      <Dialog open={newTask} onOpenChange={setNewTask}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New task</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            aria-label="Task title"
            placeholder="What needs doing?"
            value={newTitle}
            onChange={(event) => setNewTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void saveNew();
            }}
          />
          <Button disabled={!newTitle.trim()} onClick={() => void saveNew()}>
            Create task
          </Button>
        </DialogContent>
      </Dialog>
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
            The assigned agent is still working on this task. Moving it here
            will launch another agent.
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
    </SectionShell>
  );
}
export function TasksRoute(): JSX.Element {
  const { projectId } = useProjectScope();
  const [params, setParams] = useSearchParams();
  const { data: linkedTask } = useTaskDetail(params.get("task"));
  useEffect(() => {
    if (!linkedTask || params.get("project") === linkedTask.projectId) return;
    const next = new URLSearchParams(params);
    next.set("project", linkedTask.projectId);
    setParams(next, { replace: true });
  }, [linkedTask, params, setParams]);
  const boardProjectId = linkedTask?.projectId ?? projectId;
  return boardProjectId ? (
    <TasksContent key={boardProjectId} projectId={boardProjectId} />
  ) : (
    <SectionShell
      activeSection="tasks"
      sidebar={
        <div className="p-3">
          <ProjectSwitcher />
        </div>
      }
    >
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Pick a project to see its board
      </div>
    </SectionShell>
  );
}
