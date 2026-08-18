import React from "react";
import {
  AlarmClock,
  ArrowDownToLine,
  ChevronDown,
  Play,
  Radio,
  Tag,
} from "lucide-react";
import { toast } from "sonner";

import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import { type Agent } from "@/components/app/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { usePeerName } from "@/hooks/use-peers";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

function hasDefaultSessionName(agent: Agent): boolean {
  if (agent.persona) return false;
  if (agent.type === "terminal") return false;
  if (agent.name.startsWith("job-")) return false;
  return agent.name.trim() === `agent-${agent.id.slice(-6)}`;
}

export type AgentCardHeaderProps = {
  agent: Agent;
  childAgents: Agent[];
  isExpanded: boolean;
  isStopped: boolean;
  isTerminalAgent: boolean;
  connectedAgentId?: string | null;
  closeOnSessionAction: boolean;
  onRequestClose?: () => void;
  detachTerminal: () => void;
  attachToAgent: (agent: Agent) => Promise<void>;
  startAgent: (agent: Agent) => Promise<void>;
  toggleAgentDetails: (agentId: string) => void;
};

/**
 * The always-visible top row of an agent card: type icon, session name, status
 * badges, resume control for stopped agents, and the expand toggle.
 */
export function AgentCardHeader({
  agent,
  childAgents,
  isExpanded,
  isStopped,
  isTerminalAgent,
  connectedAgentId,
  closeOnSessionAction,
  onRequestClose,
  detachTerminal,
  attachToAgent,
  startAgent,
  toggleAgentDetails,
}: AgentCardHeaderProps): JSX.Element {
  const [renamePromptPending, setRenamePromptPending] = React.useState(false);
  // Which machine this agent is on has to be legible without expanding the
  // card — a collapsed sidebar is the state people actually read.
  const peerName = usePeerName(agent.peerId);
  const needsAttention = agent.status === "error";
  const isJobAgent = agent.name.startsWith("job-");
  const isAssistedUpdateAgent = agent.role === "assisted_update";
  const canPromptRename =
    agent.status === "running" && hasDefaultSessionName(agent);

  const promptAgentToRename = React.useCallback(async () => {
    if (renamePromptPending) return;
    setRenamePromptPending(true);
    try {
      await api(`/api/v1/agents/${agent.id}/prompt-rename`, {
        method: "POST",
      });
      toast.success("Asked the agent to set a session name.");
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
      className={cn(
        "flex items-center gap-1.5",
        !isStopped && "cursor-pointer"
      )}
      data-testid={`agent-row-${agent.id}`}
      onClick={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest("[data-agent-control='true']")) return;
        if (isStopped) return;
        if (connectedAgentId === agent.id) {
          detachTerminal();
          if (isExpanded) toggleAgentDetails(agent.id);
          return;
        }
        if (closeOnSessionAction) onRequestClose?.();
        void attachToAgent(agent);
      }}
    >
      <div className="flex flex-1 min-w-0 items-center gap-1.5">
        <div className="min-w-0 flex items-center gap-2 text-left text-sm font-semibold">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="shrink-0">
                <AgentTypeIcon
                  type={agent.type}
                  eventType={
                    isTerminalAgent
                      ? null
                      : agent.status === "running"
                        ? agent.latestEvent?.type
                        : null
                  }
                />
              </span>
            </TooltipTrigger>
            <TooltipContent>{agent.cwd}</TooltipContent>
          </Tooltip>
          <span
            data-testid={`agent-session-name-${agent.id}`}
            className="min-w-0 truncate"
          >
            {agent.name}
          </span>
        </div>
        {canPromptRename ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                data-agent-control="true"
                data-testid={`agent-prompt-rename-${agent.id}`}
                aria-label="Ask agent to set a session name"
                className="h-6 w-6 shrink-0 text-muted-foreground/70 hover:text-foreground [@media(pointer:coarse)]:h-10 [@media(pointer:coarse)]:w-10"
                disabled={renamePromptPending}
                onClick={() => {
                  void promptAgentToRename();
                }}
              >
                <Tag className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Ask agent to name session
              <br />
              <span className="text-muted-foreground">
                Sends a prompt asking the agent to rename itself
              </span>
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>

      {peerName ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              data-testid={`agent-peer-badge-${agent.id}`}
              // Which agent this is outranks which machine it runs on, so the
              // badge gets a hard slice of the row and shrinks before the name.
              // title, not just the tooltip: tooltips never open on touch.
              title={peerName}
              className="max-w-[8rem] shrink border-status-working/40 bg-status-working/10 text-status-working"
            >
              <Radio className="mr-1 h-3 w-3 shrink-0" />
              <span className="truncate">{peerName}</span>
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            Runs on {peerName}
            <br />
            <span className="text-muted-foreground">
              Linked instance — this card mirrors it
            </span>
          </TooltipContent>
        </Tooltip>
      ) : null}

      {needsAttention ? (
        <Badge
          className="border-status-blocked/45 bg-status-blocked/15 text-status-blocked"
          title={
            agent.lastError ??
            "Agent entered an error state and may need attention."
          }
        >
          Attention
        </Badge>
      ) : null}

      {isJobAgent ? (
        <Badge
          className="border-status-working/45 bg-status-working/15 text-status-working"
          title="Job-spawned agent"
        >
          <AlarmClock className="mr-1 h-3 w-3" />
          Job
        </Badge>
      ) : null}

      {isAssistedUpdateAgent ? (
        <Badge
          className="border-blue-500/35 bg-blue-500/10 text-blue-400"
          title="Agent-assisted Dispatch update"
        >
          <ArrowDownToLine className="mr-1 h-3 w-3" />
          Update
        </Badge>
      ) : null}

      {isStopped && agent.status !== "archiving" ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost-primary"
              data-agent-control="true"
              aria-label="Resume session"
              className="ml-auto"
              onClick={() => {
                if (closeOnSessionAction) onRequestClose?.();
                void startAgent(agent);
              }}
            >
              <Play className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            Resume
            <br />
            <span className="text-muted-foreground">Resume agent session</span>
          </TooltipContent>
        </Tooltip>
      ) : null}

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            data-agent-control="true"
            data-testid={`agent-expand-toggle-${agent.id}`}
            onClick={() => {
              // If collapsing while a child persona is connected, detach it
              if (
                isExpanded &&
                connectedAgentId &&
                childAgents.some((c) => c.id === connectedAgentId)
              ) {
                detachTerminal();
              }
              toggleAgentDetails(agent.id);
            }}
          >
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 transition-transform duration-200",
                isExpanded && "rotate-180"
              )}
            />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {isExpanded ? "Hide details" : "Show details"}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
