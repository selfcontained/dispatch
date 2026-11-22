import React from "react";
import { AlarmClock, ChevronDown, Play, Pin, Repeat2, Tag } from "lucide-react";
import { toast } from "sonner";

import { AgentSeatBadge } from "@/components/app/agent-seat-badge";
import { ChatUnreadBadge } from "@/components/app/chat/chat-unread-badge";
import { type Agent } from "@/components/app/types";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  Hint,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { IconButton } from "@/components/ui/icon-button";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

function hasDefaultSessionName(agent: Agent): boolean {
  if (agent.role === "review") return false;
  if (agent.name.startsWith("job-")) return false;
  return agent.name.trim() === `agent-${agent.id.slice(-6)}`;
}

export type AgentCardHeaderProps = {
  remoteLocation?: string;
  agent: Agent;
  childAgents: Agent[];
  isExpanded: boolean;
  isPinned?: boolean;
  isStopped: boolean;
  connectedAgentId?: string | null;
  closeOnSessionAction: boolean;
  onRequestClose?: () => void;
  closeAgent: () => void;
  openAgent: (agent: Agent) => Promise<void>;
  startAgent: (agent: Agent) => Promise<void>;
  toggleAgentDetails: (agentId: string) => void;
};

/**
 * The always-visible top row of an agent card: avatar, session name, status
 * badges, resume control for stopped agents, and the expand toggle.
 */
export function AgentCardHeader({
  remoteLocation,
  agent,
  childAgents,
  isExpanded,
  isPinned = false,
  isStopped,
  connectedAgentId,
  closeOnSessionAction,
  onRequestClose,
  closeAgent,
  openAgent,
  startAgent,
  toggleAgentDetails,
}: AgentCardHeaderProps): JSX.Element {
  const [renamePromptPending, setRenamePromptPending] = React.useState(false);
  const needsAttention = agent.status === "error";
  const isJobAgent = Boolean(agent.jobRun);
  const loopIteration = agent.jobRun?.iteration ?? 1;
  const isLoopJob = isJobAgent && agent.jobRun?.continuationEnabled;
  const loopTooltip = agent.jobRun?.maxIterations
    ? `Loop iteration ${loopIteration} of ${agent.jobRun.maxIterations}`
    : `Loop iteration ${loopIteration}`;
  const canPromptRename =
    agent.status === "running" && hasDefaultSessionName(agent);

  const promptAgentToRename = React.useCallback(async () => {
    if (renamePromptPending) return;
    setRenamePromptPending(true);
    try {
      await api(`/api/v1/agents/${agent.id}/prompt-rename`, {
        method: "POST",
      });
      toast.success("Name request queued. Follow its delivery in the stream.");
    } catch (err) {
      toast.error("Couldn't reach the agent — try again in a moment.", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      // Clear after a short delay so a rapid double-click doesn't fire twice
      // even if the agent hasn't renamed itself yet (which would otherwise
      // hide the button via canPromptRename going false).
      setTimeout(() => setRenamePromptPending(false), 1500);
    }
  }, [agent.id, renamePromptPending]);

  return (
    <div
      className="flex items-center gap-1.5 cursor-pointer"
      data-testid={`agent-row-${agent.id}`}
      onClick={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest("[data-agent-control='true']")) return;
        // A stopped agent's Chat history stays readable.
        if (connectedAgentId === agent.id) {
          closeAgent();
          if (isExpanded) toggleAgentDetails(agent.id);
          return;
        }
        if (closeOnSessionAction) onRequestClose?.();
        void openAgent(agent);
      }}
    >
      <div className="flex flex-1 min-w-0 items-center gap-1.5">
        <div className="min-w-0 flex items-center gap-2 text-left text-body-md font-semibold">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="shrink-0">
                <AgentSeatBadge
                  seat={null}
                  name={agent.name}
                  type={agent.type}
                  size="sm"
                  data-testid={`agent-avatar-${agent.id}`}
                />
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {remoteLocation ?? agent.workspacePath ?? agent.cwd}
            </TooltipContent>
          </Tooltip>
          <span
            data-testid={`agent-session-name-${agent.id}`}
            className="min-w-0 truncate"
          >
            {agent.name}
          </span>
        </div>
        {canPromptRename ? (
          <IconButton
            size="icon-sm"
            data-agent-control="true"
            data-testid={`agent-prompt-rename-${agent.id}`}
            label="Ask agent to set a session name"
            tooltip={
              <>
                Ask agent to name session
                <br />
                <span className="text-muted-foreground">
                  Queues a name request in the agent's stream
                </span>
              </>
            }
            className="text-faint hover:text-foreground"
            disabled={renamePromptPending}
            onClick={() => {
              void promptAgentToRename();
            }}
          >
            <Tag />
          </IconButton>
        ) : null}
      </div>

      {isPinned ? (
        <Hint label="Pinned session">
          <span
            role="img"
            aria-label="Pinned session"
            className="shrink-0 text-primary"
            data-testid={`agent-pinned-${agent.id}`}
          >
            <Pin aria-hidden="true" className="h-3.5 w-3.5" />
          </span>
        </Hint>
      ) : null}

      <ChatUnreadBadge agentId={agent.id} />

      {needsAttention ? (
        <Hint
          label={
            agent.lastError ??
            "Agent entered an error state and may need attention."
          }
        >
          <Badge tone="danger">Attention</Badge>
        </Hint>
      ) : null}

      {isJobAgent ? (
        <Hint label={isLoopJob ? loopTooltip : "Job-spawned agent"}>
          <Badge tone="success">
            {isLoopJob ? <Repeat2 /> : <AlarmClock />}
            {isLoopJob ? "Loop" : "Job"}
          </Badge>
        </Hint>
      ) : null}

      {isStopped && agent.status !== "archiving" ? (
        <IconButton
          tone="success"
          data-agent-control="true"
          label="Resume session"
          tooltip={
            <>
              Resume
              <br />
              <span className="text-muted-foreground">
                Resume agent session
              </span>
            </>
          }
          className="ml-auto"
          onClick={() => {
            if (closeOnSessionAction) onRequestClose?.();
            void startAgent(agent);
          }}
        >
          <Play />
        </IconButton>
      ) : null}

      <IconButton
        data-agent-control="true"
        data-testid={`agent-expand-toggle-${agent.id}`}
        label={isExpanded ? "Hide session details" : "Show session details"}
        tooltip={isExpanded ? "Hide details" : "Show details"}
        aria-expanded={isExpanded}
        onClick={() => {
          // If collapsing while a child persona is connected, detach it
          if (
            isExpanded &&
            connectedAgentId &&
            childAgents.some((c) => c.id === connectedAgentId)
          ) {
            closeAgent();
          }
          toggleAgentDetails(agent.id);
        }}
      >
        <ChevronDown
          className={cn(
            "transition-transform duration-200",
            isExpanded && "rotate-180"
          )}
        />
      </IconButton>
    </div>
  );
}
