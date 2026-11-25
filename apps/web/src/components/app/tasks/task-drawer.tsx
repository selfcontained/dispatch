import { useTaskDrawerTarget } from "./use-task-drawer-target";
import { DrawerFrame } from "../drawer";
import { Sheet, SheetClose, type SheetProps } from "@/components/ui/sheet";
import { TaskLabelPicker } from "./task-labels";
import { TaskLaunchTemplateEditor } from "./task-launch-template";
import { TaskAttachments } from "./task-attachments";
import { TaskGoalList, goalChangeLines } from "./task-goal-list";
import { TaskDeleteDialog } from "./task-delete-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/segmented-control";
import { useTaskChatUnread } from "@/hooks/use-chat-unread-summary";
import { BLOCK_PARAM, THREAD_PARAM } from "@/lib/agent-routes";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  GitPullRequest,
  MoreHorizontal,
  Plus,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Task, TaskColumn } from "@/hooks/use-tasks";
import { useTaskActions, useTaskDetail } from "@/hooks/use-tasks";
import type { Agent } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CopyButton } from "@/components/ui/copy-button";
import { Markdown } from "@/components/ui/markdown";
import { Badge } from "@/components/ui/badge";
import { CountBubble } from "@/components/ui/count-bubble";
import { IconButton } from "@/components/ui/icon-button";
import { RowButton } from "@/components/ui/row-button";
import { StatusDot } from "@/components/ui/status-dot";
import { Hint } from "@/components/ui/tooltip";
import { TaskAgent } from "./task-agent";
import { useTemplates } from "@/hooks/use-templates";
import { CreateAgentDialog } from "@/components/app/create-agent-dialog";
import { useDashboardContext } from "@/components/app/dashboard-context";
import { useQueryClient } from "@tanstack/react-query";
import { AssigneeSelect } from "./task-assignee-select";
import { cn } from "@/lib/utils";
import { TaskConversation } from "./task-conversation";
import { StatusSelect } from "./task-list";
import {
  MENU_ITEM,
  TASK_PANE_PARAM,
  assignmentLabel,
  columnAccent,
} from "./task-utils";
import { AgentName } from "@/components/app/agent-name";
import {
  formatDateTime,
  formatRelativeCompact,
  formatRelativeTime,
} from "@/lib/format";
import { statusLabel } from "@/lib/status-label";
import { Alert } from "@/components/ui/alert";
import { AsyncBoundary } from "@/components/ui/async-boundary";
import { EmptyState } from "@/components/ui/empty-state";
import { archiveTask, restoreTask } from "./task-feedback";
import { Textarea } from "@/components/ui/textarea";

/** Status and Assignee share one width and one quiet field style. */
const PROPERTY_CONTROL =
  "h-8 w-full max-w-64 border-transparent bg-surface-hover text-body-sm hover:bg-muted [[data-theme-mode=light]_&]:border-edge";

/** On the board, a press on these switches the task rather than closing it. */
const OPENS_A_TASK =
  '[data-testid^="task-card-"], [data-testid^="task-row-"], [data-opens-task]';

/** The raised surface each drawer group sits on, over the pane's base. */
const DRAWER_SURFACE =
  "rounded-lg bg-card/soft p-3 shadow-sm ring-1 ring-border-subtle";

/** A drawer group: a quiet label over its content, on its own surface. */
function DrawerSection({
  label,
  action,
  children,
}: {
  label: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className={cn(DRAWER_SURFACE, "space-y-2")}>
      <div className="flex min-h-7 items-center justify-between gap-2">
        <h3 className="section-label">{label}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}
export type TaskDetailProps = {
  id: string;
  projectId: string;
  columns: TaskColumn[];
  boardTasks: Task[];
  agents: Agent[];
  close: () => void;
  openTask: (id: string) => void;
  moveTask: (task: Task, columnId: string) => void;
  isMobile: boolean;
};

/** Shared task drawer shell on the board and over an agent session. */
export function TaskDrawerShell({
  isMobile,
  close,
  ...sheet
}: Pick<
  SheetProps,
  | "open"
  | "children"
  | "label"
  | "dialog"
  | "autoFocus"
  | "keepOpen"
  | "onOutsidePress"
> & {
  isMobile: boolean;
  close: () => void;
}) {
  if (isMobile)
    return (
      <Sheet
        label="Task"
        {...sheet}
        dialog
        autoFocus
        onOpenChange={(open) => {
          if (!open) close();
        }}
      />
    );
  return (
    <DrawerFrame
      {...sheet}
      pinned={false}
      onClose={close}
      testId="task-drawer-wrapper"
    />
  );
}

/** The same sliding task drawer on every surface. */
export function TaskDrawer({
  open = true,
  ...props
}: TaskDetailProps & { open?: boolean }) {
  const target = useTaskDrawerTarget(open && props.id ? props.id : null);
  const heldProps = useRef(props);
  if (open && props.id) heldProps.current = props;
  return (
    <TaskDrawerShell
      open={open}
      isMobile={props.isMobile}
      close={props.close}
      keepOpen={OPENS_A_TASK}
    >
      <aside
        data-testid="task-drawer"
        aria-label="Task"
        className="flex h-full min-h-0 flex-col"
        aria-hidden={!open || undefined}
        {...(!open ? { inert: "" } : {})}
      >
        {target && <TaskDetailPanel {...heldProps.current} active={open} />}
      </aside>
    </TaskDrawerShell>
  );
}

/**
 * A task's header, properties, description, agents, activity and
 * conversation. Fills a flex column of definite height: the drawer, or
 * the task modal over an agent stream.
 */
export function TaskDetailPanel({
  id,
  projectId,
  columns,
  boardTasks,
  agents,
  close,
  openTask,
  moveTask,
  isMobile,
  headerAction,
  active = true,
}: TaskDetailProps & {
  /** Rendered in the header before the close button. */
  headerAction?: React.ReactNode;
  active?: boolean;
}) {
  const taskQuery = useTaskDetail(id);
  const task = taskQuery.data;
  const actions = useTaskActions(projectId);
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const unread = useTaskChatUnread(id);
  const explicitPane = params.get(TASK_PANE_PARAM);
  const linkedConversation =
    params.has(BLOCK_PARAM) || params.has(THREAD_PARAM);
  const requestedPane =
    explicitPane === "details" || explicitPane === "conversation"
      ? explicitPane
      : linkedConversation
        ? "conversation"
        : "details";
  const heldPane = useRef(requestedPane);
  if (active) heldPane.current = requestedPane;
  const pane = active ? requestedPane : heldPane.current;
  const changePane = (value: string) => {
    const next = new URLSearchParams(params);
    next.set(TASK_PANE_PARAM, value);
    setParams(next, { replace: true, state: location.state });
  };

  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState("");
  const [editingBody, setEditingBody] = useState(false);
  const [body, setBody] = useState("");
  const [launchOpen, setLaunchOpen] = useState(false);
  const { enabledAgentTypes } = useDashboardContext();
  const queryClient = useQueryClient();
  // Only the task's project's templates can launch for it.
  const { data: templates = [] } = useTemplates();
  const projectTemplates = templates.filter(
    (template) => template.projectId === projectId
  );
  const [linkLabel, setLinkLabel] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [addingLink, setAddingLink] = useState(false);
  const currentId = useRef(id);
  currentId.current = id;
  useEffect(() => {
    setEditingTitle(false);
    setEditingBody(false);
  }, [id]);
  useEffect(() => {
    if (!editingTitle) setTitle(task?.title ?? "");
  }, [task?.id, task?.title, editingTitle]);
  useEffect(() => {
    if (!editingBody) setBody(task?.body ?? "");
  }, [task?.id, task?.body, editingBody]);
  const column = columns.find((item) => item.id === task?.columnId);
  const peers = boardTasks
    .filter((item) => item.columnId === task?.columnId)
    .sort((a, b) => a.position - b.position);
  const index = peers.findIndex((item) => item.id === id);
  // A failed save puts the draft back in its field, so nothing typed is lost.
  const saveTitle = () => {
    setEditingTitle(false);
    const next = title.trim();
    if (task && next && next !== task.title)
      void actions.update.mutateAsync({ id, title: next }).catch(() => {
        if (currentId.current !== id) return;
        setEditingTitle(true);
        setTitle(next);
      });
  };
  const saveBody = () => {
    setEditingBody(false);
    const next = body;
    if (task && next !== task.body)
      void actions.update.mutateAsync({ id, body: next }).catch(() => {
        if (currentId.current !== id) return;
        setEditingBody(true);
        setBody(next);
      });
  };
  const memberIds = useMemo(
    () => task?.agents.map((item) => item.agentId) ?? [],
    [task?.agents]
  );
  const assignee =
    agents.find((agent) => agent.id === task?.assignedAgentId) ?? null;
  const creator =
    task?.createdBy.kind === "agent" ? (
      <AgentName agentId={task.createdBy.agentId} />
    ) : (
      task?.createdBy.kind
    );
  const failed = taskFailure(actions, id);
  return (
    <>
      <header className="flex min-h-14 shrink-0 items-center gap-1 border-b border-border-subtle pl-2 pr-2 pt-safe text-body-sm text-muted-foreground">
        <span className="flex min-w-0 flex-1 items-center gap-2 px-1">
          {column && (
            <StatusDot
              color={`hsl(${columnAccent(column, columns.indexOf(column))})`}
            />
          )}
          <span className="truncate">
            {column?.name ?? "Task"} · <span className="font-mono">{id}</span>
          </span>
          <CopyButton text={id} label="Copy task ID" className="shrink-0" />
        </span>
        <IconButton
          disabled={index <= 0}
          onClick={() => openTask(peers[index - 1].id)}
          label="Previous task"
        >
          <ChevronLeft />
        </IconButton>
        <IconButton
          disabled={index < 0 || index >= peers.length - 1}
          onClick={() => openTask(peers[index + 1].id)}
          label="Next task"
        >
          <ChevronRight />
        </IconButton>
        {headerAction}
        <SheetClose onClick={close} />
      </header>
      {failed && (
        <Alert
          title={failed.title}
          error={failed.error}
          className="mx-3 mt-2"
          action={
            // An open editor saves again when it loses focus.
            failed.retry && !editingTitle && !editingBody
              ? { label: "Retry", onClick: failed.retry }
              : undefined
          }
          onDismiss={failed.dismiss}
        />
      )}
      <AsyncBoundary
        query={taskQuery}
        thing="the task"
        className="m-4"
        notFound={
          <EmptyState
            title="Task not found"
            description="It may have been deleted, or the link may be wrong."
          />
        }
      >
        {(task) => (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="shrink-0 border-b border-border-subtle px-3 py-2">
              <SegmentedControl
                layout="fill"
                aria-label="Task panes"
                value={pane}
                onValueChange={changePane}
              >
                <SegmentedControlItem value="details">
                  Details
                </SegmentedControlItem>
                <SegmentedControlItem value="conversation">
                  Conversation
                  {!!unread && (
                    <CountBubble
                      tone="info"
                      count={unread}
                      aria-label={`${unread} unread posts`}
                    />
                  )}
                </SegmentedControlItem>
              </SegmentedControl>
            </div>
            {pane === "details" && (
              <section
                aria-label="Details"
                className="flex min-h-0 flex-1 flex-col"
              >
                <div
                  data-testid="task-drawer-body"
                  className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
                >
                  <div className="space-y-6 p-4">
                    {editingTitle ? (
                      <Input
                        autoFocus
                        value={title}
                        onChange={(event) => setTitle(event.target.value)}
                        onBlur={saveTitle}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") saveTitle();
                          if (event.key === "Escape") {
                            // Cancels the edit, not the drawer.
                            event.preventDefault();
                            setEditingTitle(false);
                          }
                        }}
                      />
                    ) : (
                      <RowButton
                        className="-mx-1 block w-full break-words px-1 text-heading-lg leading-7"
                        onClick={() => setEditingTitle(true)}
                      >
                        {task.title}
                      </RowButton>
                    )}
                    <section
                      className={cn(
                        DRAWER_SURFACE,
                        "grid grid-cols-[88px_minmax(0,1fr)] items-center gap-x-3 gap-y-2 text-body-md"
                      )}
                    >
                      <span className="text-body-sm text-muted-foreground">
                        Labels
                      </span>
                      <div className="min-w-0">
                        <TaskLabelPicker
                          key={task.id}
                          projectId={task.projectId}
                          value={task.labels ?? []}
                          disabled={actions.update.isPending}
                          onChange={(labels) => {
                            actions.update.mutate({ id, labels });
                          }}
                        />
                      </div>
                      <span className="text-body-sm text-muted-foreground">
                        Status
                      </span>
                      {task.archivedAt ? (
                        <span className="text-body-md text-muted-foreground">
                          Archived · {column?.name}
                        </span>
                      ) : (
                        <StatusSelect
                          task={task}
                          columns={columns}
                          moveTask={moveTask}
                          className={PROPERTY_CONTROL}
                        />
                      )}
                      <span className="text-body-sm text-muted-foreground">
                        Assignee
                      </span>
                      <AssigneeSelect
                        value={task.assignedAgentId}
                        agents={agents}
                        projectId={projectId}
                        onChange={(assignedAgentId) =>
                          actions.update.mutate({ id, assignedAgentId })
                        }
                        onNew={() => setLaunchOpen(true)}
                        templates={projectTemplates}
                        onLaunchTemplate={(templateId) =>
                          actions.launch.mutate({ id, templateId })
                        }
                      />
                      <span className="text-body-sm text-muted-foreground">
                        Created
                      </span>
                      <Hint label={formatDateTime(task.createdAt)}>
                        <span className="text-body-sm">
                          by {creator} · {formatRelativeTime(task.createdAt)}
                        </span>
                      </Hint>
                    </section>
                    {!!task.goals?.length && (
                      <DrawerSection label="Goals">
                        <TaskGoalList goals={task.goals} />
                      </DrawerSection>
                    )}
                    {columns.some((c) => c.trigger) && (
                      <DrawerSection label="Launch template">
                        <TaskLaunchTemplateEditor key={task.id} task={task} />
                      </DrawerSection>
                    )}
                    <DrawerSection label="Description">
                      {editingBody ? (
                        <Textarea
                          autoFocus
                          aria-label="Description"
                          className="min-h-36"
                          value={body}
                          onChange={(event) => setBody(event.target.value)}
                          onBlur={saveBody}
                          onKeyDown={(event) => {
                            if (
                              event.key === "Enter" &&
                              (event.metaKey || event.ctrlKey)
                            )
                              saveBody();
                          }}
                        />
                      ) : (
                        <RowButton
                          className="-mx-2 block min-h-12 w-[calc(100%+1rem)] px-2 py-1 text-body-md text-foreground"
                          onClick={() => setEditingBody(true)}
                        >
                          {task.body ? (
                            <Markdown>{task.body}</Markdown>
                          ) : (
                            <span className="text-muted-foreground">
                              Add a deliverable and acceptance criteria…
                            </span>
                          )}
                        </RowButton>
                      )}
                    </DrawerSection>
                    {!!task.attachments?.length && (
                      <DrawerSection label="Attachments">
                        <TaskAttachments
                          key={task.id}
                          attachments={task.attachments}
                          updatedAt={task.updatedAt}
                        />
                      </DrawerSection>
                    )}
                    <DrawerSection
                      label="Links"
                      action={
                        addingLink ? null : (
                          <Button
                            variant="ghost"
                            size="xs"
                            onClick={() => setAddingLink(true)}
                          >
                            <Plus />
                            Add link
                          </Button>
                        )
                      }
                    >
                      {task.links.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {task.links.map((link) => (
                            <a
                              key={link.url ?? link.label}
                              href={link.url ?? undefined}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex max-w-full items-center gap-1 rounded-md bg-surface-hover px-2 py-1 text-body-sm text-primary hover:bg-muted"
                            >
                              {link.kind === "pr" && (
                                <GitPullRequest
                                  className="h-3 w-3 shrink-0"
                                  aria-hidden="true"
                                />
                              )}
                              <span className="truncate">{link.label}</span>
                              <ExternalLink className="h-3 w-3 shrink-0" />
                            </a>
                          ))}
                        </div>
                      )}
                      {addingLink && (
                        <div className="flex flex-col gap-2 sm:flex-row">
                          <Input
                            aria-label="Link label"
                            placeholder="Label"
                            value={linkLabel}
                            onChange={(event) =>
                              setLinkLabel(event.target.value)
                            }
                          />
                          <Input
                            aria-label="Link URL"
                            placeholder="URL"
                            value={linkUrl}
                            onChange={(event) => setLinkUrl(event.target.value)}
                          />
                          <div className="flex gap-2">
                            <Button
                              variant="ghost"
                              onClick={() => setAddingLink(false)}
                            >
                              Cancel
                            </Button>
                            <Button
                              onClick={() => {
                                if (linkLabel && linkUrl)
                                  void actions.update
                                    .mutateAsync({
                                      id,
                                      links: [
                                        ...task.links,
                                        {
                                          kind: "url",
                                          label: linkLabel,
                                          url: linkUrl,
                                        },
                                      ],
                                    })
                                    .then(
                                      () => {
                                        setAddingLink(false);
                                        setLinkLabel("");
                                        setLinkUrl("");
                                      },
                                      // Shown at the top, with the draft kept.
                                      () => {}
                                    );
                              }}
                            >
                              Add
                            </Button>
                          </div>
                        </div>
                      )}
                      {!task.links.length && !addingLink && (
                        <p className="text-body-sm text-muted-foreground">
                          No links
                        </p>
                      )}
                    </DrawerSection>
                    <DrawerSection label="Agents">
                      {task.agents.length ? (
                        <div className="space-y-1">
                          {task.agents.map((assignment) => {
                            const current =
                              assignment.agentId === task.assignedAgentId;
                            const agent = agents.find(
                              (item) => item.id === assignment.agentId
                            );
                            return (
                              <div
                                key={assignment.agentId}
                                data-testid={`task-agent-row-${assignment.agentId}`}
                                className="flex items-center gap-2 rounded-lg px-1 py-0.5 hover:bg-surface-hover"
                              >
                                <TaskAgent
                                  agent={agent}
                                  agentId={assignment.agentId}
                                  agents={agents}
                                  projectId={projectId}
                                  fullWidth
                                />
                                <Hint
                                  label={`${assignmentLabel(assignment, columns)} · ${formatDateTime(assignment.assignedAt)}`}
                                >
                                  <span className="ml-auto flex shrink-0 items-center gap-2 text-body-sm text-muted-foreground">
                                    {current && (
                                      <Badge size="sm">Assignee</Badge>
                                    )}
                                    {formatRelativeCompact(
                                      assignment.assignedAt
                                    )}
                                  </span>
                                </Hint>
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <IconButton
                                      size="icon-sm"
                                      label={
                                        agent
                                          ? `Options for ${agent.name}`
                                          : "Agent options"
                                      }
                                      aria-labelledby={
                                        agent
                                          ? undefined
                                          : `agent-options-${assignment.agentId}`
                                      }
                                    >
                                      {!agent && (
                                        <span
                                          id={`agent-options-${assignment.agentId}`}
                                          className="sr-only"
                                        >
                                          Options for{" "}
                                          <AgentName
                                            agentId={assignment.agentId}
                                          />
                                        </span>
                                      )}
                                      <MoreHorizontal aria-hidden="true" />
                                    </IconButton>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end">
                                    {current ? (
                                      <DropdownMenuItem
                                        className={MENU_ITEM}
                                        onSelect={() =>
                                          actions.update.mutate({
                                            id,
                                            assignedAgentId: null,
                                          })
                                        }
                                      >
                                        Unassign
                                      </DropdownMenuItem>
                                    ) : (
                                      <DropdownMenuItem
                                        className={MENU_ITEM}
                                        onSelect={() =>
                                          actions.update.mutate({
                                            id,
                                            assignedAgentId: assignment.agentId,
                                          })
                                        }
                                      >
                                        Make assignee
                                      </DropdownMenuItem>
                                    )}
                                    <DropdownMenuItem
                                      onSelect={() =>
                                        actions.removeAgent.mutate({
                                          id,
                                          agentId: assignment.agentId,
                                        })
                                      }
                                    >
                                      Remove from task
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="text-body-sm text-muted-foreground">
                          No agents yet
                        </p>
                      )}
                    </DrawerSection>
                    <DrawerSection label="Activity">
                      <ol className="space-y-2 border-l-2 border-border-subtle pl-3">
                        {task.events.map((event) => (
                          <li key={event.id} className="text-body-sm">
                            <span className="font-medium">
                              {event.kind === "trigger_launching"
                                ? `Launching ${projectTemplates.find((template) => template.id === event.data.templateId)?.name ?? "agent"}`
                                : statusLabel(event.kind)}
                            </span>
                            <Hint label={formatDateTime(event.createdAt)}>
                              <span className="ml-2 text-muted-foreground">
                                {formatRelativeTime(event.createdAt)}
                              </span>
                            </Hint>
                            {typeof event.data.reason === "string" && (
                              <p className="text-danger">{event.data.reason}</p>
                            )}
                            {event.kind === "goals_changed" && (
                              <ul className="break-words text-muted-foreground">
                                {goalChangeLines(event.data).map(
                                  (line, index) => (
                                    <li key={index}>{line}</li>
                                  )
                                )}
                              </ul>
                            )}
                          </li>
                        ))}
                      </ol>
                    </DrawerSection>
                  </div>
                </div>
                {task.archivedAt && (
                  <div
                    className="border-t border-border-subtle px-3 py-2 text-body-md text-muted-foreground"
                    role="status"
                  >
                    Archived — restore this task to move it.
                  </div>
                )}
                <footer className="flex shrink-0 items-center gap-2 border-t border-border-subtle bg-card/veil px-3 py-2 pb-safe-2">
                  {task.id === id && (
                    <TaskDeleteDialog key={id} task={task} close={close} />
                  )}
                  <Button
                    size="sm"
                    className="ml-auto"
                    pending={
                      actions.archive?.isPending || actions.restore?.isPending
                    }
                    onClick={() =>
                      task.archivedAt
                        ? restoreTask(actions, task, {
                            failureShownInline: true,
                          })
                        : archiveTask(actions, task, {
                            failureShownInline: true,
                          })
                    }
                  >
                    {task.archivedAt ? "Restore" : "Archive"}
                  </Button>
                </footer>
              </section>
            )}
            {/* Kept mounted, so its draft and scroll outlive a look at Details. */}
            <section
              aria-label="Conversation"
              className={cn(
                "min-h-0 flex-1 px-2 pb-safe-2 pt-2 md:px-3 md:pb-3",
                pane !== "conversation" && "hidden"
              )}
            >
              <TaskConversation
                key={task.id}
                taskId={task.id}
                active={active && pane === "conversation"}
                assignee={assignee}
                isMobile={isMobile}
                memberIds={memberIds}
              />
            </section>
          </div>
        )}
      </AsyncBoundary>
      {task && (
        <CreateAgentDialog
          open={launchOpen}
          setOpen={setLaunchOpen}
          enabledAgentTypes={enabledAgentTypes}
          initialAgentType={null}
          resolveDefaultCwd={() => ""}
          task={{ id: task.id, title: task.title, projectId: task.projectId }}
          onCreated={async () => {
            setLaunchOpen(false);
            await queryClient.invalidateQueries({ queryKey: ["tasks"] });
          }}
        />
      )}
    </>
  );
}

/** The drawer's failed action on this task, and how to try it again. */
function taskFailure(
  actions: ReturnType<typeof useTaskActions>,
  id: string
):
  | { title: string; error: unknown; retry?: () => void; dismiss: () => void }
  | undefined {
  const { update, launch, removeAgent, archive, restore } = actions;
  if (update?.error && update.variables?.id === id) {
    const input = update.variables;
    return {
      title: "Couldn’t save the task.",
      error: update.error,
      retry: () => update.mutate(input),
      dismiss: update.reset,
    };
  }
  if (launch?.error && launch.variables?.id === id) {
    const input = launch.variables;
    return {
      title: "Couldn’t launch the agent.",
      error: launch.error,
      retry: () => launch.mutate(input),
      dismiss: launch.reset,
    };
  }
  if (removeAgent?.error && removeAgent.variables?.id === id) {
    const input = removeAgent.variables;
    return {
      title: "Couldn’t remove the agent from the task.",
      error: removeAgent.error,
      retry: () => removeAgent.mutate(input),
      dismiss: removeAgent.reset,
    };
  }
  if (archive?.error && archive.variables === id)
    return {
      title: "Couldn’t archive the task.",
      error: archive.error,
      dismiss: archive.reset,
    };
  if (restore?.error && restore.variables === id)
    return {
      title: "Couldn’t restore the task.",
      error: restore.error,
      dismiss: restore.reset,
    };
  return undefined;
}
