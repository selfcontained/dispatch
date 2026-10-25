import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAtom } from "jotai";
import { LayoutGrid, List, Plus, X, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { SectionShell } from "./section-shell";
import { ProjectSwitcher } from "@/components/app/project-switcher";
import { ProjectIcon } from "@/components/app/project-location";
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
import { taskLayoutAtomFamily } from "@/lib/store";
import { TaskBoard } from "@/components/app/tasks/task-board";
import { TaskList } from "@/components/app/tasks/task-list";
import { TaskDrawer } from "@/components/app/tasks/task-drawer";
import { TaskCreateDialog } from "@/components/app/tasks/task-create-dialog";
import { useMoveTask } from "@/components/app/tasks/use-move-task";
import {
  columnAccent,
  needsAttention,
  TASK_PANE_PARAM,
  orderedColumns,
  templateName,
  visibleTasks,
} from "@/components/app/tasks/task-utils";
import { useTemplates } from "@/hooks/use-templates";

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
  // A ?layout= link is a one-off view; only the toggle saves a choice.
  // Phones default to List until one is saved.
  const layout =
    params.get("layout") === "list" || params.get("layout") === "board"
      ? (params.get("layout") as "list" | "board")
      : (savedLayout ?? (isMobile ? "list" : "board"));
  // The create dialog is open on a column (null: the first one).
  const [newTask, setNewTask] = useState<{ columnId: string | null } | null>(
    null
  );
  const [search, setSearch] = useState("");
  const [assignee, setAssignee] = useState("all");
  const { moveTask, dialog: relaunchDialog } = useMoveTask(projectId, board);
  const { data: templates } = useTemplates();
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
    if (name === "task") next.delete(TASK_PANE_PARAM);
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
  // A column picked in the sidebar is a filter: the board keeps only it,
  // the list only its group. Picking it again shows everything.
  const onlyColumn =
    columns.find((column) => column.key === params.get("column")) ?? null;
  const showColumn = (columnId: string) => {
    leaveSidebar();
    const column = columns.find((item) => item.id === columnId);
    updateParam(
      "column",
      column && column.id !== onlyColumn?.id ? column.key : null
    );
  };
  const startNewTask = (columnId: string | null = null) => {
    leaveSidebar();
    setNewTask({ columnId });
  };
  // A new task is selected: its drawer on desktop; on a phone, where the
  // drawer would cover the board, its card scrolled to and focused.
  const selectNew = (task: Task) => {
    if (!isMobile) return openTask(task.id);
    requestAnimationFrame(() => {
      const card = document.querySelector<HTMLElement>(
        `[data-testid="task-card-${task.id}"], [data-testid="task-row-${task.id}"]`
      );
      card?.scrollIntoView({ block: "center", inline: "center" });
      (card?.matches("[tabindex]")
        ? card
        : card?.querySelector("button")
      )?.focus({ preventScroll: true });
    });
  };
  const sidebar = (
    <div className="space-y-5 p-3">
      <ProjectSwitcher allowAll={false} />
      <Button className="w-full justify-start" onClick={() => startNewTask()}>
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
            data-testid={`task-nav-column-${column.key}`}
            aria-pressed={onlyColumn?.id === column.id}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/60",
              onlyColumn?.id === column.id && "bg-muted/70 font-medium"
            )}
            onClick={() => showColumn(column.id)}
          >
            <span
              aria-hidden="true"
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: `hsl(${columnAccent(column, index)})` }}
            />
            <span className="min-w-0 flex-1 truncate">{column.name}</span>
            {column.trigger && (
              <span
                title={`Launches ${templateName(templates, column.trigger.templateId)} when a task enters`}
                aria-label={`Launches ${templateName(templates, column.trigger.templateId)} when a task enters`}
                className="inline-flex text-muted-foreground"
              >
                <Zap className="h-3.5 w-3.5" aria-hidden="true" />
              </span>
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
            {onlyColumn && (
              <button
                data-testid="task-column-filter"
                className="flex shrink-0 items-center gap-1.5 rounded-full bg-muted/60 py-0.5 pl-2.5 pr-1.5 text-xs hover:bg-muted"
                onClick={() => updateParam("column", null)}
                aria-label={`Show all columns (showing only ${onlyColumn.name})`}
              >
                <span
                  aria-hidden="true"
                  className="h-2 w-2 rounded-full"
                  style={{
                    background: `hsl(${columnAccent(onlyColumn, columns.indexOf(onlyColumn))})`,
                  }}
                />
                {onlyColumn.name}
                <X
                  className="h-3 w-3 text-muted-foreground"
                  aria-hidden="true"
                />
              </button>
            )}
            <Button
              size="icon"
              variant="ghost"
              className="md:hidden"
              aria-label="New task"
              onClick={() => startNewTask()}
            >
              <Plus className="h-4 w-4" />
            </Button>
            <div className="flex shrink-0 rounded-lg bg-muted/50 p-0.5 md:order-last">
              <Button
                size="sm"
                variant={layout === "board" ? "default" : "ghost"}
                aria-pressed={layout === "board"}
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
                aria-pressed={layout === "list"}
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
                addTask={(columnId) => startNewTask(columnId)}
                onlyColumnId={onlyColumn?.id ?? null}
              />
            ) : (
              <TaskList
                board={board}
                tasks={tasks}
                agents={agents}
                openTask={openTask}
                moveTask={moveTask}
                onlyColumnId={onlyColumn?.id ?? null}
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
      <TaskCreateDialog
        open={!!newTask}
        onOpenChange={(open) => {
          if (!open) setNewTask(null);
        }}
        projectId={projectId}
        columns={columns}
        agents={agents}
        columnId={newTask?.columnId}
        onCreated={selectNew}
      />
      {relaunchDialog}
    </SectionShell>
  );
}
export function TasksRoute(): JSX.Element {
  const { projectId, projects } = useProjectScope();
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
          <ProjectSwitcher allowAll={false} />
        </div>
      }
    >
      {/* Boards are per project, so with none chosen the page is the choice. */}
      <div className="flex h-full items-center justify-center p-6">
        <div className="w-full max-w-sm text-center">
          <h1 className="text-lg font-semibold">Choose a project</h1>
          <p className="mb-4 text-sm text-muted-foreground">
            {projects.length
              ? "Each project has its own board."
              : "Create a project from the switcher to start a board."}
          </p>
          <div className="space-y-1">
            {projects.map((project) => (
              <button
                key={project.id}
                className="flex w-full items-center justify-center gap-3 rounded-lg border border-border/60 bg-card/60 px-3 py-2 text-sm hover:bg-muted/60"
                onClick={() => {
                  const next = new URLSearchParams(params);
                  next.set("project", project.id);
                  setParams(next);
                }}
              >
                <ProjectIcon project={project} className="h-5 w-5" />
                <span className="min-w-0 truncate">{project.name}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </SectionShell>
  );
}
