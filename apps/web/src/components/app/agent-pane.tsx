import { useProjects } from "@/hooks/use-projects";
import { useAssignedTasks } from "@/hooks/use-tasks";
import { useSearchParams } from "react-router-dom";
import { TaskModal } from "./tasks/task-modal";
import { TASK_MODAL_STATE, TASK_PANE_PARAM } from "./tasks/task-utils";
import { ProjectIcon } from "./project-location";
import { ScheduledMessagesButton } from "./scheduled-messages-button";
import { useAtom } from "jotai";
import { chatShowLastMessageAtom } from "@/lib/store";
import { useEffect, useState } from "react";
import { Hash, Settings } from "lucide-react";

import { PendingInputsButton } from "./chat/pending-inputs-button";
import { ChatPane } from "@/components/app/chat/chat-pane";
import { type Agent } from "@/components/app/types";
import { agentSwitchValidationMode } from "@/lib/agent-switch-validation";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export type ChatFiltersButtonProps = {
  showChildAgents?: boolean;
  onShowChildAgentsChange?: (show: boolean) => void;
};

/** Opens the agent's task over the stream (`?task=`), not on the board. */
export function AssignedTaskChip({ agentId }: { agentId: string }) {
  const { data: tasks = [] } = useAssignedTasks(agentId);
  const [params, setParams] = useSearchParams();
  const task = tasks[0];
  return task ? (
    <button
      type="button"
      className="max-w-44 truncate rounded bg-primary/10 px-2 py-0.5 text-[11px] text-primary hover:bg-primary/20"
      onClick={() => {
        const next = new URLSearchParams(params);
        next.set("task", task.id);
        next.set(TASK_PANE_PARAM, "conversation");
        setParams(next, { state: TASK_MODAL_STATE });
      }}
      title={task.title}
      aria-haspopup="dialog"
    >
      Task: {task.title}
    </button>
  ) : null;
}

/** The Chat options popover in the Agent pane header. */
export function ChatFiltersButton({
  showChildAgents = false,
  onShowChildAgentsChange,
}: ChatFiltersButtonProps): JSX.Element {
  const [showLastMessage, setShowLastMessage] = useAtom(
    chatShowLastMessageAtom
  );
  const filtersLabel = showChildAgents
    ? "Chat options"
    : "Chat options, child agents hidden";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={filtersLabel}
          title={filtersLabel}
          data-testid="chat-filters-trigger"
          className={cn(
            "group h-7 w-7 shrink-0 rounded-full p-0 hover:bg-transparent focus-visible:ring-0 pointer-coarse:h-11 pointer-coarse:w-11",
            !showChildAgents && "text-primary"
          )}
        >
          <span
            data-testid="chat-filters-surface"
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded-full transition-colors group-hover:bg-muted/70 group-focus-visible:ring-2 group-focus-visible:ring-ring",
              !showChildAgents && "bg-primary/10"
            )}
          >
            <Settings data-testid="chat-filters-icon" className="h-3.5 w-3.5" />
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-64 p-3"
        data-testid="chat-filters-popover"
      >
        <div className="mb-2 text-xs font-semibold text-foreground">
          Chat options
        </div>
        <label
          htmlFor="show-child-agents"
          className="flex cursor-pointer items-center justify-between gap-4 rounded-md px-1 py-1.5"
        >
          <span className="min-w-0">
            <span className="block text-sm font-medium">
              Show child messages
            </span>
            <span className="block text-xs text-muted-foreground">
              Include agent coordination. Launches and reviews stay visible when
              off.
            </span>
          </span>
          <Switch
            id="show-child-agents"
            data-testid="show-child-agents-switch"
            checked={showChildAgents}
            onCheckedChange={onShowChildAgentsChange}
            aria-label="Show child messages"
          />
        </label>
        <label
          htmlFor="show-last-message"
          className="flex cursor-pointer items-center justify-between gap-4 rounded-md px-1 py-1.5"
        >
          <span className="min-w-0">
            <span className="block text-sm font-medium text-foreground">
              Your last message
            </span>
            <span className="block text-xs text-muted-foreground">
              Keep your request visible above the stream.
            </span>
          </span>
          <Switch
            id="show-last-message"
            checked={showLastMessage}
            onCheckedChange={setShowLastMessage}
            aria-label="Your last message"
            data-testid="show-last-message-switch"
          />
        </label>
      </PopoverContent>
    </Popover>
  );
}

export type AgentPaneProps = {
  agentId: string | null;
  agent: Agent | null;
  agents?: Agent[];
  /** The pane is on screen (its tab is active, or it sits in a split). */
  active: boolean;
  showChildAgents: boolean;
  onShowChildAgentsChange: (show: boolean) => void;
  /**
   * Render the pane's own header row (agent name + filters). A split pane
   * has a header of its own and puts `ChatFiltersButton` there instead.
   */
  header: boolean;
  openLightbox: (fileId: number, order?: number[]) => void;
  /** Opens the Changes tab on a file (a review finding's path). */
  onOpenPath?: (path: string, line: number | null) => void;
  isMobile: boolean;
};

/** The Agent tab's contents: the agent's Chat feed and composer. */
export function AgentPane({
  agentId,
  agent,
  agents,
  active,
  showChildAgents,
  onShowChildAgentsChange,
  header,
  openLightbox,
  onOpenPath,
  isMobile,
}: AgentPaneProps): JSX.Element {
  const [mountedAgentId, setMountedAgentId] = useState(agentId);
  const { data: projects = [] } = useProjects();
  const project = projects.find((p) => p.id === agent?.projectId);

  // Route changes should paint the newly selected agent before mounting its
  // cached feed. Rendering a large cached stream in the navigation commit
  // otherwise leaves the previous agent selected until that work finishes.
  useEffect(() => {
    if (agentSwitchValidationMode === "before") return;
    if (mountedAgentId === agentId) return;
    let timer: number | undefined;
    const frame = window.requestAnimationFrame(() => {
      timer = window.setTimeout(() => setMountedAgentId(agentId), 0);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [agentId, mountedAgentId]);

  return (
    <div
      className="flex h-full min-h-0 min-w-0 max-w-full flex-col overflow-hidden"
      data-testid="agent-pane"
    >
      {header ? (
        <div
          className="flex min-h-8 shrink-0 items-center justify-between gap-2 border-b border-border/40 py-0 pl-3 pr-2 md:py-1.5"
          data-testid="agent-pane-header"
          style={
            project
              ? {
                  background: `linear-gradient(90deg, ${project.color}28, ${project.color}0d)`,
                  boxShadow: `inset 3px 0 ${project.color}`,
                }
              : undefined
          }
        >
          <span className="flex min-w-0 items-center gap-1 text-xs font-medium text-foreground">
            {project ? (
              <ProjectIcon
                project={project}
                className="h-5 w-5"
                fallback={
                  <Hash className="h-3.5 w-3.5 text-muted-foreground" />
                }
              />
            ) : (
              <Hash className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate">{agent?.name ?? "Agent"}</span>
            {agentId && <AssignedTaskChip agentId={agentId} />}
          </span>
          {agentSwitchValidationMode ? (
            <span
              className="text-[10px] text-muted-foreground"
              data-testid="agent-switch-validation-mode"
            >
              Validation: {agentSwitchValidationMode} fix
            </span>
          ) : null}
          <div className="flex shrink-0 items-center gap-1">
            <PendingInputsButton
              key={agentId}
              agentId={agentId}
              showChildAgents={showChildAgents}
            />
            <ScheduledMessagesButton
              key={`schedules-${agentId}`}
              agentId={agentId}
            />
            <ChatFiltersButton
              showChildAgents={showChildAgents}
              onShowChildAgentsChange={onShowChildAgentsChange}
            />
          </div>
        </div>
      ) : null}
      <div className="relative min-h-0 min-w-0 max-w-full flex-1 overflow-hidden">
        {/*
         * Keyed per agent: the pane's dismissed question, send error and
         * scroll position are agent-local, and a direct /agents/a →
         * /agents/b transition must not carry them across.
         */}
        {agentSwitchValidationMode === "before" ||
        mountedAgentId === agentId ? (
          <ChatPane
            key={agentId ?? "none"}
            agentId={agentId}
            agent={agent}
            agents={agents}
            active={active}
            showChildAgents={showChildAgents}
            onShowChildAgentsChange={onShowChildAgentsChange}
            openLightbox={openLightbox}
            onOpenPath={onOpenPath}
            isMobile={isMobile}
          />
        ) : (
          <div
            className="flex h-full items-center justify-center text-sm text-muted-foreground"
            data-testid="agent-chat-opening"
          >
            Opening chat…
          </div>
        )}
      </div>
      <TaskModal agents={agents ?? []} isMobile={isMobile} />
    </div>
  );
}
