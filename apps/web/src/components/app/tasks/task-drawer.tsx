import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import { X, ChevronLeft, ChevronRight, ExternalLink, Plus } from "lucide-react";
import type { Task, TaskColumn } from "@/hooks/use-tasks";
import { useTaskActions, useTaskDetail } from "@/hooks/use-tasks";
import type { Agent } from "@/components/app/types";
import { useTemplates } from "@/hooks/use-templates";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { TaskAgent } from "./task-agent";
import { StatusSelect } from "./task-list";
import { taskAge } from "./task-utils";
import { ThreadPage } from "@/components/app/drawer/thread-page";
import { FileLightbox } from "@/components/app/file-lightbox";
import { AgentTypeSelect } from "@/components/app/agent-type-select";
import { AgentModelSelect } from "@/components/app/agent-model-select";
import { useAgentModelCatalog } from "@/hooks/use-agent-model-catalog";
import type { AgentType } from "@/lib/agent-types";

function TaskConversation({
  streamId,
  blockId,
  projectId,
  agent,
}: {
  streamId: string;
  blockId: string;
  projectId: string;
  agent: Agent | null;
}) {
  const navigate = useNavigate();
  const [fileId, setFileId] = useState<number | null>(null);
  const [fileIds, setFileIds] = useState<number[]>([]);
  return (
    <div className="space-y-2">
      <div className="flex h-[30rem] min-h-0 overflow-hidden rounded-lg border border-border/60">
        <ThreadPage
          agentId={agent?.id ?? streamId}
          agent={agent}
          rootId={streamId}
          blockId={blockId}
          findingId={null}
          isMobile={false}
          openLightbox={(id, order) => {
            setFileId(id);
            setFileIds(order ?? [id]);
          }}
          onOpenThread={(id, findingId) =>
            navigate(
              `/agents/${streamId}?project=${encodeURIComponent(projectId)}&thread=${encodeURIComponent(id)}${findingId ? `&finding=${encodeURIComponent(findingId)}` : ""}`
            )
          }
          onBack={() => undefined}
        />
      </div>
      <FileLightbox fileId={fileId} fileIds={fileIds} setFileId={setFileId} />
      <Link
        className="text-sm text-primary hover:underline"
        to={`/agents/${streamId}?thread=${encodeURIComponent(blockId)}&project=${encodeURIComponent(projectId)}`}
      >
        Open conversation →
      </Link>
    </div>
  );
}
export function TaskDrawer({
  id,
  projectId,
  columns,
  boardTasks,
  agents,
  close,
  openTask,
  moveTask,
}: {
  id: string;
  projectId: string;
  columns: TaskColumn[];
  boardTasks: Task[];
  agents: Agent[];
  close: () => void;
  openTask: (id: string) => void;
  moveTask: (task: Task, columnId: string) => void;
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
    setTitle(task?.title ?? "");
    setBody(task?.body ?? "");
    setEditingTitle(false);
    setEditingBody(false);
  }, [task?.id, task?.title, task?.body]);
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
  const conversation = task?.agents.find(
    (item) => item.agentId === task.assignedAgentId
  )?.conversation;
  return (
    <aside
      data-testid="task-drawer"
      className="absolute inset-0 z-20 flex flex-col border-l border-border bg-background shadow-xl md:left-auto md:w-[560px]"
    >
      <header className="flex items-center gap-2 border-b border-border p-3 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">
          {column?.name ?? "Task"} · {id}
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
        >
          <X className="h-4 w-4" />
        </Button>
      </header>
      {isLoading && (
        <p className="p-5 text-sm text-muted-foreground">Loading task…</p>
      )}
      {task && (
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-5">
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
              className="w-full text-left text-xl font-semibold"
              onClick={() => setEditingTitle(true)}
            >
              {task.title}
            </button>
          )}
          <section className="grid grid-cols-[95px_1fr] items-center gap-3 text-sm">
            <span className="text-muted-foreground">Status</span>
            <StatusSelect task={task} columns={columns} moveTask={moveTask} />
            <span className="text-muted-foreground">Assignee</span>
            <div>
              <TaskAgent
                agent={agents.find(
                  (agent) => agent.id === task.assignedAgentId
                )}
                projectId={projectId}
              />
            </div>
            <span className="text-muted-foreground">Created</span>
            <span>
              {task.createdBy.kind === "agent"
                ? `by ${agents.find((agent) => agent.id === (task.createdBy.kind === "agent" ? task.createdBy.agentId : ""))?.name ?? task.createdBy.agentId}`
                : `by ${task.createdBy.kind}`}{" "}
              · {taskAge(task.createdAt)} ago
            </span>
          </section>
          <section>
            <h3 className="mb-2 text-sm font-semibold">Links</h3>
            <div className="space-y-1">
              {task.links.map((link) => (
                <a
                  key={link.url ?? link.label}
                  href={link.url ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 text-sm text-primary hover:underline"
                >
                  {link.label}
                  <ExternalLink className="h-3 w-3" />
                </a>
              ))}
            </div>
            {addingLink ? (
              <div className="mt-2 flex gap-2">
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
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setAddingLink(true)}
              >
                <Plus className="mr-1 h-3 w-3" />
                Add link
              </Button>
            )}
          </section>
          <section>
            <h3 className="mb-2 text-sm font-semibold">Description</h3>
            {editingBody ? (
              <textarea
                autoFocus
                className="min-h-36 w-full rounded border border-border bg-background p-2 text-sm"
                value={body}
                onChange={(event) => setBody(event.target.value)}
                onBlur={saveBody}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
                    saveBody();
                }}
              />
            ) : (
              <button
                className="prose prose-sm min-h-16 w-full max-w-none rounded border border-transparent p-2 text-left text-foreground hover:border-border"
                onClick={() => setEditingBody(true)}
              >
                {task.body ? (
                  <ReactMarkdown>{task.body}</ReactMarkdown>
                ) : (
                  <span className="text-muted-foreground">
                    Add a deliverable and acceptance criteria…
                  </span>
                )}
              </button>
            )}
          </section>
          <section>
            <h3 className="mb-2 text-sm font-semibold">Agents on this task</h3>
            <div className="space-y-1">
              {task.agents.length ? (
                task.agents.map((assignment) => (
                  <div
                    key={assignment.agentId}
                    className="flex items-center justify-between rounded-lg border border-border/60 bg-background/30 px-2 py-1.5"
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
                ))
              ) : (
                <p className="text-xs text-muted-foreground">No agents yet</p>
              )}
            </div>
          </section>
          <section>
            <h3 className="mb-2 text-sm font-semibold">Activity</h3>
            <ol className="space-y-2 border-l border-border pl-3">
              {task.events.map((event) => (
                <li key={event.id} className="text-xs">
                  <span className="font-medium">
                    {event.kind.replaceAll("_", " ")}
                  </span>
                  <span className="ml-2 text-muted-foreground">
                    {taskAge(event.createdAt)} ago
                  </span>
                  {typeof event.data.reason === "string" && (
                    <p className="text-destructive">{event.data.reason}</p>
                  )}
                </li>
              ))}
            </ol>
          </section>
          <section>
            <h3 className="mb-2 text-sm font-semibold">Conversation</h3>
            {conversation ? (
              <TaskConversation
                streamId={conversation.streamId}
                blockId={conversation.blockId}
                projectId={projectId}
                agent={
                  agents.find((agent) => agent.id === task.assignedAgentId) ??
                  null
                }
              />
            ) : (
              <p className="text-xs text-muted-foreground">
                Assign an agent to start a conversation.
              </p>
            )}
          </section>
        </div>
      )}
      {task && (
        <footer className="flex flex-wrap items-center gap-2 border-t border-border p-3">
          <Button onClick={() => setLaunchOpen(true)}>Launch agent…</Button>
          <Select
            value={task.columnId}
            onValueChange={(value) => moveTask(task, value)}
          >
            <SelectTrigger aria-label="Move to" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {columns.map((item) => (
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
            variant="destructive"
            className="ml-auto"
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
