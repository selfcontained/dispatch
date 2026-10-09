import React from "react";

import { AgentActivityLabel } from "@/components/app/agent-activity";
import { type Agent } from "@/components/app/types";
import { agentProjectRoot } from "@/components/app/agents-view-utils";
import { ActivityBars } from "@/components/ui/activity-bars";
import {
  useAgentTurnLabel,
  useFirstAgentWithTurnLabel,
} from "@/hooks/use-agent-turn-label";
import { cn } from "@/lib/utils";

function RepoLabel({ agentId, name }: { agentId: string; name: string }) {
  const [iconError, setIconError] = React.useState(false);

  return (
    <span
      className="ml-auto flex min-w-0 max-w-full items-center gap-1"
      title={name}
    >
      <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground/60">
        {name}
      </span>
      {!iconError ? (
        <img
          src={`/api/v1/agents/${agentId}/repo-icon`}
          alt=""
          loading="lazy"
          className="h-5 w-5 shrink-0 rounded-sm object-contain"
          onError={() => setIconError(true)}
        />
      ) : null}
    </span>
  );
}

/**
 * Setup and archive are lifecycle phases, separate from a turn's ACP steps.
 * The stream's workspace block carries setup's individual steps.
 */
export function AgentCardPhaseStatus({
  agent,
  className,
}: {
  agent: Agent;
  className?: string;
}): JSX.Element | null {
  if (agent.status === "creating" || agent.setupPhase) {
    return (
      <div
        className={cn(
          "mt-1 flex min-w-0 items-center gap-1.5 text-xs text-status-working",
          className
        )}
      >
        <ActivityBars size={12} className="shrink-0" />
        <span className="truncate font-medium">Starting…</span>
      </div>
    );
  }

  if (agent.status === "archiving") {
    return (
      <div
        className={cn(
          "mt-1 flex min-w-0 items-center gap-1.5 text-xs text-orange-400",
          className
        )}
      >
        <ActivityBars size={12} className="shrink-0" />
        <span className="truncate font-medium">
          {agent.archivePhase === "stopping"
            ? "Stopping agent…"
            : agent.archivePhase === "worktree-check"
              ? "Checking worktree…"
              : agent.archivePhase === "worktree-cleanup"
                ? "Removing worktree…"
                : agent.archivePhase === "finalizing"
                  ? "Finalizing…"
                  : "Archiving…"}
        </span>
      </div>
    );
  }

  return null;
}

/** Whether AgentCardPhaseStatus has a lifecycle line to show. */
function hasPhaseStatus(agent: Agent): boolean {
  return (
    agent.status === "creating" ||
    Boolean(agent.setupPhase) ||
    agent.status === "archiving"
  );
}

/**
 * The agent's status line above the repo it works in: a lifecycle phase
 * (starting, archiving) when one is under way, otherwise the current turn's
 * reported step. The line keeps its height when there is nothing to say, so
 * the card does not grow and shrink as turns start and end.
 */
export function AgentCardActivity({
  agent,
  childAgents = [],
  onNavigate,
}: {
  agent: Agent;
  /**
   * Sub agents whose activity stands in when the agent itself has none: the
   * first one with a step to show.
   */
  childAgents?: Agent[];
  /** Called as the running-turn link navigates. */
  onNavigate?: () => void;
}): JSX.Element {
  const repoName = agentProjectRoot(agent)?.split("/").pop() ?? null;
  const ownStep = useAgentTurnLabel(
    agent.id,
    agent.currentTurn?.blockId ?? null
  );
  const hasOwnActivity =
    hasPhaseStatus(agent) ||
    Boolean(agent.reconnect) ||
    Boolean(agent.currentTurn && ownStep);
  const activeChild = useFirstAgentWithTurnLabel(
    hasOwnActivity ? [] : childAgents.filter((child) => child.currentTurn)
  );

  return (
    <div className="mt-1 flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
      <div
        className="flex min-h-4 min-w-0 items-center"
        data-testid={`agent-status-line-${agent.id}`}
      >
        {hasPhaseStatus(agent) ? (
          <AgentCardPhaseStatus agent={agent} className="mt-0" />
        ) : (
          <AgentActivityLabel
            agent={activeChild ?? agent}
            className="w-full"
            linkToTurn
            onNavigate={onNavigate}
          />
        )}
      </div>
      {repoName && !agent.reconnect ? (
        <RepoLabel agentId={agent.id} name={repoName} />
      ) : null}
    </div>
  );
}
