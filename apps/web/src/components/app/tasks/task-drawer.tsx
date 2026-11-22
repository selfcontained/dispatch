import { useTaskDrawerTarget } from "./use-task-drawer-target";
import { DrawerFrame } from "../drawer";
import { GlassSidebar } from "@/components/ui/glass-sidebar";
import { glassPanel } from "@/lib/glass";
import { TaskLabelPicker } from "./task-labels";
import { TaskLaunchTemplateEditor } from "./task-launch-template";
import { TaskAttachments } from "./task-attachments";
import { TaskDeleteDialog } from "./task-delete-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useTaskChatUnread } from "@/hooks/use-chat-unread-summary";
import { BLOCK_PARAM, THREAD_PARAM } from "@/lib/agent-routes";
import {
  ArrowLeft,
  X,
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
import { AgentSessionLink } from "@/components/app/agent-session-link";
import {
  formatDateTime,
  formatRelativeCompact,
  formatRelativeTime,
} from "@/lib/format";
import { statusLabel } from "@/lib/status-label";

/** Status and Assignee share one width and one quiet field style. */
const PROPERTY_CONTROL =
  "h-8 w-full max-w-64 border-transparent bg-surface-hover text-body-sm hover:bg-muted";

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
  open,
  isMobile,
  close,
  children,
}: {
  open: boolean;
  isMobile: boolean;
  close: () => void;
  children: React.ReactNode;
}) {
  if (isMobile)
    return (
      <GlassSidebar
        open={open}
        onOpenChange={(value) => {
          if (!value) close();
        }}
        side="right"
        mobile
        label="Task"
      >
        {children}
      </GlassSidebar>
    );
  return (
    <DrawerFrame open={open} pinned={false} testId="task-drawer-wrapper">
      <div
        className={cn(
          "flex h-full min-h-0 flex-col rounded-l-lg border-l text-foreground",
          glassPanel
        )}
      >
        {children}
      </div>
    </DrawerFrame>
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
    <TaskDrawerShell open={open} isMobile={props.isMobile} close={props.close}>
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
  const { data: task, isLoading } = useTaskDetail(id);
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
  const saveTitle = () => {
    setEditingTitle(false);
    if (task && title.trim() && title.trim() !== task.title)
      void actions.update.mutateAsync({ id, title: title.trim() });
  };
  const saveBody = () => {
    setEditingBody(false);
    if (task && body !== task.body)
      void actions.update.mutateAsync({ id, body });
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
  return (
    <>
      <header className="flex min-h-14 shrink-0 items-center gap-1 border-b border-border-subtle pl-1.5 pr-2 pt-safe text-body-sm text-muted-foreground">
        <Button
          size="icon"
          variant="ghost"
          onClick={close}
          aria-label="Close task"
          className="md:hidden"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <span className="flex min-w-0 flex-1 items-center gap-2 px-1">
          {column && (
            <span
              aria-hidden="true"
              className="h-2 w-2 shrink-0 rounded-full"
              style={{
                background: `hsl(${columnAccent(column, columns.indexOf(column))})`,
              }}
            />
          )}
          <span className="truncate">
            {column?.name ?? "Task"} · <span className="font-mono">{id}</span>
          </span>
          <CopyButton text={id} label="Copy task ID" className="shrink-0" />
        </span>
        <Button
          size="icon"
          variant="ghost"
          disabled={index <= 0}
          onClick={() => openTask(peers[index - 1].id)}
          aria-label="Previous task"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          disabled={index < 0 || index >= peers.length - 1}
          onClick={() => openTask(peers[index + 1].id)}
          aria-label="Next task"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
        {headerAction}
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
      {isLoading && (
        <p className="p-4 text-body-md text-muted-foreground">Loading task…</p>
      )}
      {task && (
        <Tabs
          value={pane}
          onValueChange={changePane}
          className="flex min-h-0 flex-1 flex-col"
        >
          <TabsList aria-label="Task panes" className="mx-3 my-2 shrink-0">
            <TabsTrigger value="details">Details</TabsTrigger>
            <TabsTrigger value="conversation">
              Conversation
              {!!unread && (
                <span
                  className="ml-2 rounded-full bg-primary px-1.5 text-label-xs text-primary-foreground"
                  aria-label={`${unread} unread posts`}
                >
                  {unread}
                </span>
              )}
            </TabsTrigger>
          </TabsList>
          <TabsContent
            value="details"
            className="mt-0 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
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
                      if (event.key === "Escape") setEditingTitle(false);
                    }}
                  />
                ) : (
                  <button
                    className="-mx-1 w-full break-words rounded-md px-1 text-left text-heading-lg leading-7 hover:bg-surface-hover"
                    onClick={() => setEditingTitle(true)}
                  >
                    {task.title}
                  </button>
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
                        void actions.update
                          .mutateAsync({ id, labels })
                          .catch(() => {});
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
                      void actions.update.mutateAsync({ id, assignedAgentId })
                    }
                    onNew={() => setLaunchOpen(true)}
                    templates={projectTemplates}
                    onLaunchTemplate={(templateId) =>
                      void actions.launch.mutateAsync({ id, templateId })
                    }
                  />
                  <span className="text-body-sm text-muted-foreground">
                    Created
                  </span>
                  <span
                    className="text-body-sm"
                    title={formatDateTime(task.createdAt)}
                  >
                    by {creator} · {formatRelativeTime(task.createdAt)}
                  </span>
                </section>
                {columns.some((c) => c.trigger) && (
                  <DrawerSection label="Launch template">
                    <TaskLaunchTemplateEditor key={task.id} task={task} />
                  </DrawerSection>
                )}
                <DrawerSection label="Description">
                  {editingBody ? (
                    <textarea
                      autoFocus
                      className="min-h-36 w-full rounded-lg bg-surface-subtle p-3 text-body-md outline-none ring-1 ring-border-subtle focus-ring"
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
                    <button
                      className="-mx-2 min-h-12 w-[calc(100%+1rem)] rounded-lg px-2 py-1 text-left text-body-md text-foreground hover:bg-surface-hover"
                      onClick={() => setEditingBody(true)}
                    >
                      {task.body ? (
                        <Markdown headingAccents>{task.body}</Markdown>
                      ) : (
                        <span className="text-muted-foreground">
                          Add a deliverable and acceptance criteria…
                        </span>
                      )}
                    </button>
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
                        size="sm"
                        className="h-7 text-body-sm"
                        onClick={() => setAddingLink(true)}
                      >
                        <Plus className="mr-1 h-3 w-3" />
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
                        onChange={(event) => setLinkLabel(event.target.value)}
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
                                .then(() => {
                                  setAddingLink(false);
                                  setLinkLabel("");
                                  setLinkUrl("");
                                });
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
                            {agent ? (
                              <TaskAgent
                                agent={agent}
                                agents={agents}
                                projectId={projectId}
                                fullWidth
                              />
                            ) : (
                              // The live list has no archived agents.
                              <AgentSessionLink
                                agentId={assignment.agentId}
                                projectId={projectId}
                                decorative={false}
                                className="min-w-0 truncate text-body-sm text-muted-foreground"
                              >
                                <AgentName agentId={assignment.agentId} />
                              </AgentSessionLink>
                            )}
                            <span
                              className="ml-auto flex shrink-0 items-center gap-2 text-body-sm text-muted-foreground"
                              title={`${assignmentLabel(assignment, columns)} · ${formatDateTime(assignment.assignedAt)}`}
                            >
                              {current && (
                                <span className="rounded-full bg-muted px-1.5 py-0.5 text-label-xs font-medium text-foreground">
                                  Assignee
                                </span>
                              )}
                              {formatRelativeCompact(assignment.assignedAt)}
                            </span>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-7 w-7 shrink-0 text-muted-foreground"
                                  aria-label={
                                    agent
                                      ? `Options for ${agent.name}`
                                      : undefined
                                  }
                                >
                                  {!agent && (
                                    <span className="sr-only">
                                      Options for{" "}
                                      <AgentName agentId={assignment.agentId} />
                                    </span>
                                  )}
                                  <MoreHorizontal
                                    className="h-4 w-4"
                                    aria-hidden="true"
                                  />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                {current ? (
                                  <DropdownMenuItem
                                    className={MENU_ITEM}
                                    onSelect={() =>
                                      void actions.update.mutateAsync({
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
                                      void actions.update.mutateAsync({
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
                                    void actions.removeAgent.mutateAsync({
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
                        <span
                          className="ml-2 text-muted-foreground"
                          title={formatDateTime(event.createdAt)}
                        >
                          {formatRelativeTime(event.createdAt)}
                        </span>
                        {typeof event.data.reason === "string" && (
                          <p className="text-danger">{event.data.reason}</p>
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
            {actions.restore?.error &&
              actions.restore.variables === task.id && (
                <p role="alert" className="px-3 py-2 text-body-md text-danger">
                  {actions.restore.error.message}
                </p>
              )}
            <footer className="flex shrink-0 items-center gap-2 border-t border-border-subtle bg-card/veil px-3 py-2 pb-safe-2">
              <Button
                size="sm"
                variant="default"
                disabled={
                  actions.archive?.isPending || actions.restore?.isPending
                }
                onClick={() =>
                  task.archivedAt
                    ? actions.restore.mutate(task.id)
                    : actions.archive.mutate(task.id)
                }
              >
                {task.archivedAt ? "Restore" : "Archive"}
              </Button>
              {task.id === id && (
                <TaskDeleteDialog key={id} task={task} close={close} />
              )}
            </footer>
          </TabsContent>
          <TabsContent
            value="conversation"
            forceMount
            className="mt-0 min-h-0 flex-1 data-[state=inactive]:hidden px-2 pb-safe-2 md:px-3 md:pb-3"
          >
            <TaskConversation
              key={task.id}
              taskId={task.id}
              active={active && pane === "conversation"}
              assignee={assignee}
              isMobile={isMobile}
              memberIds={memberIds}
            />
          </TabsContent>
        </Tabs>
      )}
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
