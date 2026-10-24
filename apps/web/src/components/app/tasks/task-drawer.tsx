import { useEffect, useState } from "react";
import {
  ArrowLeft,
  X,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Plus,
} from "lucide-react";
import type { Task, TaskColumn, TaskDetail } from "@/hooks/use-tasks";
import { useTaskActions, useTaskDetail } from "@/hooks/use-tasks";
import type { Agent } from "@/components/app/types";
import { useTemplates } from "@/hooks/use-templates";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Markdown } from "@/components/ui/markdown";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TaskAgent, TaskAgentChip } from "./task-agent";
import { TaskConversation } from "./task-conversation";
import { StatusSelect } from "./task-list";
import { assigneeOptions, columnAccent, taskAge } from "./task-utils";
import { AgentTypeSelect } from "@/components/app/agent-type-select";
import { AgentModelSelect } from "@/components/app/agent-model-select";
import { useAgentModelCatalog } from "@/hooks/use-agent-model-catalog";
import type { AgentType } from "@/lib/agent-types";

const ago = (date: string) => {
  const age = taskAge(date);
  return age === "now" ? "just now" : `${age} ago`;
};

/** A drawer group: a quiet label over its content, no box around it. */
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
    <section className="space-y-2">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}
function AssigneeSelect({
  task,
  agents,
  projectId,
  onChange,
}: {
  task: TaskDetail;
  agents: Agent[];
  projectId: string;
  onChange: (agentId: string | null) => void;
}) {
  const options = assigneeOptions(agents, projectId, task.assignedAgentId);
  return (
    <Select
      value={task.assignedAgentId ?? UNASSIGNED}
      onValueChange={(value) => onChange(value === UNASSIGNED ? null : value)}
    >
      <SelectTrigger
        aria-label="Assignee"
        className="h-8 w-full max-w-64 border-transparent bg-muted/50 text-xs hover:bg-muted"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={UNASSIGNED}>
          <span className="text-muted-foreground">Unassigned</span>
        </SelectItem>
        {options.map((agent) => (
          <SelectItem key={agent.id} value={agent.id}>
            <TaskAgentChip agent={agent} compact />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
const UNASSIGNED = "__unassigned";
export function TaskDrawer({
  id,
  projectId,
  columns,
  boardTasks,
  agents,
  close,
  openTask,
  moveTask,
  isMobile,
}: {
  id: string;
  projectId: string;
  columns: TaskColumn[];
  boardTasks: Task[];
  agents: Agent[];
  close: () => void;
  openTask: (id: string) => void;
  moveTask: (task: Task, columnId: string) => void;
  isMobile: boolean;
}) {
  const { data: task, isLoading } = useTaskDetail(id);
  const actions = useTaskActions(projectId);
  const { data: templates = [] } = useTemplates();
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState("");
  const [editingBody, setEditingBody] = useState(false);
  const [body, setBody] = useState("");
  const [launchOpen, setLaunchOpen] = useState(false);
  const [templateId, setTemplateId] = useState("");
  const [launchType, setLaunchType] = useState<AgentType | null>(null);
  const [launchModel, setLaunchModel] = useState<string | null>(null);
  const selectedTemplate = templates.find((item) => item.id === templateId);
  const chosenLaunchType =
    launchType ?? selectedTemplate?.agentType ?? "claude";
  const models = useAgentModelCatalog(chosenLaunchType);
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
  const assignee =
    agents.find((agent) => agent.id === task?.assignedAgentId) ?? null;
  const creator =
    task?.createdBy.kind === "agent"
      ? (() => {
          const agentId = task.createdBy.agentId;
          return agents.find((agent) => agent.id === agentId)?.name ?? agentId;
        })()
      : task?.createdBy.kind;
  return (
    <aside
      data-testid="task-drawer"
      aria-label="Task"
      className="fixed inset-0 z-40 flex flex-col bg-background md:absolute md:inset-y-0 md:left-auto md:right-0 md:z-20 md:w-[600px] md:border-l md:border-border/40 md:shadow-2xl"
    >
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
        <span className="flex min-w-0 flex-1 items-center gap-2 truncate px-1">
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
        <p className="p-5 text-sm text-muted-foreground">Loading task…</p>
      )}
      {task && (
        <div
          data-testid="task-drawer-body"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain [container-type:size]"
        >
          <div className="space-y-6 p-4 md:p-5">
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
                className="-mx-1 w-full break-words rounded-md px-1 text-left text-xl font-semibold leading-7 hover:bg-muted/40"
                onClick={() => setEditingTitle(true)}
              >
                {task.title}
              </button>
            )}
            <section className="grid grid-cols-[88px_minmax(0,1fr)] items-center gap-x-3 gap-y-2 rounded-xl bg-muted/30 p-3 text-sm">
              <span className="text-xs text-muted-foreground">Status</span>
              <StatusSelect task={task} columns={columns} moveTask={moveTask} />
              <span className="text-xs text-muted-foreground">Assignee</span>
              <AssigneeSelect
                task={task}
                agents={agents}
                projectId={projectId}
                onChange={(assignedAgentId) =>
                  void actions.update.mutateAsync({ id, assignedAgentId })
                }
              />
              <span className="text-xs text-muted-foreground">Created</span>
              <span className="text-xs">
                by {creator} · {ago(task.createdAt)}
              </span>
            </section>
            <DrawerSection label="Description">
              {editingBody ? (
                <textarea
                  autoFocus
                  className="min-h-36 w-full rounded-lg bg-muted/40 p-3 text-sm outline-none ring-1 ring-border/60 focus:ring-ring"
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
                  className="-mx-2 min-h-12 w-[calc(100%+1rem)] rounded-lg px-2 py-1 text-left text-sm text-foreground hover:bg-muted/40"
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
            <DrawerSection
              label="Links"
              action={
                addingLink ? null : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
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
                      className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted/50 px-2 py-1 text-xs text-primary hover:bg-muted"
                    >
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
                                { kind: "url", label: linkLabel, url: linkUrl },
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
                <p className="text-xs text-muted-foreground">No links</p>
              )}
            </DrawerSection>
            <DrawerSection label="Agents on this task">
              {task.agents.length ? (
                <div className="space-y-1">
                  {task.agents.map((assignment) => (
                    <div
                      key={assignment.agentId}
                      className="flex items-center justify-between gap-2 rounded-lg px-1 py-0.5 hover:bg-muted/30"
                    >
                      <TaskAgent
                        agent={agents.find(
                          (agent) => agent.id === assignment.agentId
                        )}
                        projectId={projectId}
                      />
                      <span className="text-xs text-muted-foreground">
                        {assignment.role}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">No agents yet</p>
              )}
            </DrawerSection>
            <DrawerSection label="Activity">
              <ol className="space-y-2 border-l-2 border-border/50 pl-3">
                {task.events.map((event) => (
                  <li key={event.id} className="text-xs">
                    <span className="font-medium">
                      {event.kind.replaceAll("_", " ")}
                    </span>
                    <span className="ml-2 text-muted-foreground">
                      {ago(event.createdAt)}
                    </span>
                    {typeof event.data.reason === "string" && (
                      <p className="text-destructive">{event.data.reason}</p>
                    )}
                  </li>
                ))}
              </ol>
            </DrawerSection>
          </div>
          {/* One drawer-height tall: scrolled to, the conversation has
              the whole body and its feed scrolls on its own. */}
          <section
            aria-label="Conversation"
            className="flex h-[100cqh] min-h-80 flex-col gap-2 px-2 pb-2 md:px-3 md:pb-3"
          >
            <h3 className="flex min-h-9 items-center px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Conversation
            </h3>
            <div className="min-h-0 flex-1">
              <TaskConversation
                // Remount per task: the feed's scroll and open thread are
                // the task's own.
                key={task.id}
                taskId={task.id}
                assignee={assignee}
                isMobile={isMobile}
              />
            </div>
          </section>
        </div>
      )}
      {task && (
        <footer className="flex shrink-0 items-center gap-2 border-t border-border/40 bg-card/60 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          <Button size="sm" onClick={() => setLaunchOpen(true)}>
            Launch agent…
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => {
              if (window.confirm(`Delete ${task.title}?`))
                void actions.remove.mutateAsync(task.id).then(close);
            }}
          >
            Delete
          </Button>
        </footer>
      )}
      <Dialog open={launchOpen} onOpenChange={setLaunchOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Launch agent for task</DialogTitle>
          </DialogHeader>
          <Select value={templateId} onValueChange={setTemplateId}>
            <SelectTrigger aria-label="Launch template">
              <SelectValue placeholder="Choose a template" />
            </SelectTrigger>
            <SelectContent>
              {templates
                .filter((item) => item.projectId === projectId)
                .map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <AgentTypeSelect
            id="task-launch-runtime"
            value={chosenLaunchType}
            onChange={setLaunchType}
            agentTypes={["claude", "codex", "opencode"]}
            label="Runtime"
          />
          <AgentModelSelect
            id="task-launch-model"
            testId="task-launch-model"
            value={launchModel}
            options={models.options}
            onChange={setLaunchModel}
            loading={models.loading}
          />
          <Button
            disabled={!templateId}
            onClick={() => {
              void actions.launch
                .mutateAsync({
                  id,
                  templateId,
                  agentType: chosenLaunchType,
                  model: models.normalizeModel(launchModel),
                })
                .then(() => setLaunchOpen(false));
            }}
          >
            Launch
          </Button>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
