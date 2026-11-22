import { NotificationsDrawer } from "@/components/app/notifications-drawer";
import { TaskLabelFilter } from "@/components/app/tasks/task-label-filter";
import { BLOCK_PARAM, THREAD_PARAM } from "@/lib/agent-routes";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAtom } from "jotai";
import { LayoutGrid, List, Plus, X, Zap } from "lucide-react";
import { formatDateTime, formatRelativeCompact } from "@/lib/format";
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
import { ChipButton } from "@/components/ui/chip";
import { IconButton } from "@/components/ui/icon-button";
import { RowButton } from "@/components/ui/row-button";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/segmented-control";
import { StatusDot } from "@/components/ui/status-dot";
import { Hint } from "@/components/ui/tooltip";
import { taskLayoutAtomFamily } from "@/lib/store";
import { ColumnCapacity } from "@/components/app/tasks/task-column-capacity";
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
  const archived = params.get("view") === "archived";
  const {
    data: activeBoard,
    isLoading: activeLoading,
    error: activeError,
  } = useTaskBoard(projectId);
  const {
    data: archivedBoard,
    isLoading: archivedLoading,
    error: archivedError,
  } = useTaskBoard(archived ? projectId : null, true);
  const board = archived ? archivedBoard : activeBoard;
  const isLoading = archived ? archivedLoading : activeLoading;
  const error = archived ? archivedError : activeError;
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
  const selectedLabels = new Set(
    params
      .getAll("label")
      .filter(Boolean)
      .map((name) => name.toLowerCase())
  );
  const tasks = board
    ? (archived ? board.tasks : visibleTasks(board.tasks, columns)).filter(
        (task) =>
          task.title.toLowerCase().includes(search.toLowerCase()) &&
          matchesAssignee(task) &&
          (!selectedLabels.size ||
            task.labels?.some((label) =>
              selectedLabels.has(label.name.toLowerCase())
            ))
      )
    : [];
  const attentionCount = board
    ? board.tasks.filter((task) => needsAttention(task, attention)).length
    : 0;
  const updateParam = (name: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    if (name === "task") {
      next.delete(TASK_PANE_PARAM);
      next.delete(BLOCK_PARAM);
      next.delete(THREAD_PARAM);
    }
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
    <div className="space-y-4 p-3">
      <ProjectSwitcher allowAll={false} />
      <Button className="w-full justify-start" onClick={() => startNewTask()}>
        <Plus />
        New task
      </Button>
      <div>
        <h2 className="mb-2 px-2 section-label">Columns</h2>
        {columns.map((column, index) => (
          <RowButton
            key={column.id}
            data-testid={`task-nav-column-${column.key}`}
            aria-pressed={onlyColumn?.id === column.id}
            className={cn(
              "px-2 py-1.5 text-body-md",
              onlyColumn?.id === column.id && "bg-surface-hover font-medium"
            )}
            onClick={() => showColumn(column.id)}
          >
            <StatusDot color={`hsl(${columnAccent(column, index)})`} />
            <span className="min-w-0 flex-1 truncate">{column.name}</span>
            {column.trigger && (
              <Hint
                label={`Launches ${templateName(templates, column.trigger.templateId)} when a task enters`}
              >
                <span
                  role="img"
                  aria-label={`Launches ${templateName(templates, column.trigger.templateId)} when a task enters`}
                  className="inline-flex text-muted-foreground"
                >
                  <Zap className="size-icon-md" aria-hidden="true" />
                </span>
              </Hint>
            )}
            <ColumnCapacity column={column} />
          </RowButton>
        ))}
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 w-full justify-start"
          onClick={() => {
            const name = window.prompt("New column name");
            if (name?.trim())
              void actions.createColumn.mutateAsync({ name: name.trim() });
          }}
        >
          <Plus /> Add column
        </Button>
      </div>
    </div>
  );
  return (
    <SectionShell
      activeSection="tasks"
      headerActions={<NotificationsDrawer />}
      sidebar={sidebar}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="flex flex-col gap-2 px-3 py-2 md:flex-row md:items-center md:px-4 md:py-3">
          <div className="flex min-w-0 items-center gap-2 md:mr-auto">
            <h1 className="min-w-0 flex-1 truncate text-heading-lg">
              Tasks{" "}
              <span className="text-body-md font-normal text-muted-foreground">
                · {project?.name}
              </span>
            </h1>
            {onlyColumn && (
              <ChipButton
                data-testid="task-column-filter"
                className="max-w-32 shrink"
                onClick={() => updateParam("column", null)}
                aria-label={`Show all columns (showing only ${onlyColumn.name})`}
              >
                <StatusDot
                  color={`hsl(${columnAccent(onlyColumn, columns.indexOf(onlyColumn))})`}
                />
                <span className="min-w-0 truncate">{onlyColumn.name}</span>
                <X aria-hidden="true" />
              </ChipButton>
            )}
            <IconButton
              className="md:hidden"
              label="New task"
              onClick={() => startNewTask()}
            >
              <Plus />
            </IconButton>
            <Button
              size="sm"
              variant="ghost"
              pressed={archived}
              onClick={() => updateParam("view", archived ? null : "archived")}
            >
              Archived
            </Button>
            <SegmentedControl
              aria-label="Layout"
              className="shrink-0 md:order-last"
              value={layout}
              onValueChange={setLayout}
            >
              <SegmentedControlItem value="board" aria-label="Board layout">
                <LayoutGrid />
                <span className="hidden md:inline">Board</span>
              </SegmentedControlItem>
              <SegmentedControlItem value="list" aria-label="List layout">
                <List />
                <span className="hidden md:inline">List</span>
              </SegmentedControlItem>
            </SegmentedControl>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2 md:flex-nowrap">
            <Input
              aria-label="Search tasks"
              placeholder="Search tasks"
              className="h-8 min-w-0 flex-1 basis-full md:w-44 md:flex-none md:basis-auto pointer-coarse:h-11"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <TaskLabelFilter
              labels={[
                ...(board?.labels ?? []),
                ...(board?.hiddenLabels ?? []),
              ]}
            />
            <Select value={assignee} onValueChange={setAssignee}>
              <SelectTrigger
                aria-label="Filter by assignee"
                className="h-8 w-40 min-w-0 flex-1 basis-0 md:flex-none md:basis-auto pointer-coarse:h-11"
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
          <p className="p-4 text-body-md text-muted-foreground">
            Loading board…
          </p>
        )}
        {error && (
          <p className="p-4 text-body-md text-danger">
            Could not load tasks: {error.message}
          </p>
        )}
        {board && (
          <div className="min-h-0 flex-1">
            {archived ? (
              <div className="h-full overflow-auto p-4">
                <h2 className="mb-3 text-heading-md">Archived tasks</h2>
                {actions.restore.error && (
                  <p role="alert" className="mb-3 text-body-md text-danger">
                    {actions.restore.error.message}
                  </p>
                )}
                <div className="mb-3 flex flex-wrap gap-2">
                  {columns
                    .filter(
                      (column) => !onlyColumn || column.id === onlyColumn.id
                    )
                    .map((column) => (
                      <span
                        key={column.id}
                        className="inline-flex items-center gap-1 text-body-sm"
                      >
                        {column.name} <ColumnCapacity column={column} />
                      </span>
                    ))}
                </div>
                {tasks.length === 0 && (
                  <p className="text-body-md text-muted-foreground">
                    No archived tasks.
                  </p>
                )}
                {tasks
                  .filter(
                    (task) => !onlyColumn || task.columnId === onlyColumn.id
                  )
                  .map((task) => (
                    <div
                      key={task.id}
                      className="flex items-center gap-3 border-b border-border-subtle py-3"
                    >
                      <RowButton
                        className="min-w-0 flex-1 rounded-sm text-body-md hover:bg-transparent hover:underline"
                        onClick={() => openTask(task.id)}
                      >
                        <span className="min-w-0 truncate">{task.title}</span>
                      </RowButton>
                      <span className="text-body-sm text-muted-foreground">
                        {
                          columns.find((column) => column.id === task.columnId)
                            ?.name
                        }
                      </span>
                      {task.archivedAt && (
                        <Hint label={formatDateTime(task.archivedAt)}>
                          <time
                            className="text-body-sm text-muted-foreground"
                            dateTime={task.archivedAt}
                          >
                            Archived {formatRelativeCompact(task.archivedAt)}
                          </time>
                        </Hint>
                      )}
                      <Button
                        size="sm"
                        disabled={actions.restore.isPending}
                        onClick={() => actions.restore.mutate(task.id)}
                      >
                        Restore
                      </Button>
                    </div>
                  ))}
              </div>
            ) : layout === "board" ? (
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
      {board && (
        <TaskDrawer
          id={params.get("task") ?? ""}
          open={Boolean(params.get("task"))}
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
      headerActions={<NotificationsDrawer />}
      sidebar={
        <div className="p-3">
          <ProjectSwitcher allowAll={false} />
        </div>
      }
    >
      {/* Boards are per project, so with none chosen the page is the choice. */}
      <div className="flex h-full items-center justify-center p-6">
        <div className="w-full max-w-sm text-center">
          <h1 className="text-heading-lg">Choose a project</h1>
          <p className="mb-4 text-body-md text-muted-foreground">
            {projects.length
              ? "Each project has its own board."
              : "Create a project from the switcher to start a board."}
          </p>
          <div className="space-y-1">
            {projects.map((project) => (
              <RowButton
                key={project.id}
                className="justify-center gap-3 rounded-lg border border-border-subtle bg-card/veil px-3 py-2 text-body-md"
                onClick={() => {
                  const next = new URLSearchParams(params);
                  next.set("project", project.id);
                  setParams(next);
                }}
              >
                <ProjectIcon project={project} className="h-5 w-5" />
                <span className="min-w-0 truncate">{project.name}</span>
              </RowButton>
            ))}
          </div>
        </div>
      </div>
    </SectionShell>
  );
}
