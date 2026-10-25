import React from "react";

import { AgentActivityLabel } from "@/components/app/agent-activity";
import { type Agent } from "@/components/app/types";
import { agentProjectRoot } from "@/components/app/agents-view-utils";
import { ActivityBars } from "@/components/ui/activity-bars";
import {
  agentPhaseStatus,
  hasPhaseStatus,
  useAgentActivity,
} from "@/hooks/use-agent-activity";
import { cn } from "@/lib/utils";
import { useProjectScope } from "@/hooks/use-projects";

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
  const phase = agentPhaseStatus(agent);
  if (!phase) return null;
  return (
    <div
      className={cn(
        "mt-1 flex min-w-0 items-center gap-1.5 text-xs",
        phase.tone === "starting" ? "text-status-working" : "text-orange-400",
        className
      )}
    >
      <ActivityBars size={12} className="shrink-0" />
      <span className="truncate font-medium">{phase.label}</span>
    </div>
  );
}

export { hasPhaseStatus };

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
  const { projectId } = useProjectScope();
  const repoName = agentProjectRoot(agent)?.split("/").pop() ?? null;
  const activity = useAgentActivity(agent, childAgents);

  return (
    <div className="mt-1 flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
      <div
        className="flex min-h-4 min-w-0 items-center"
        data-testid={`agent-status-line-${agent.id}`}
      >
        {activity.kind === "phase" ? (
          <AgentCardPhaseStatus agent={agent} className="mt-0" />
        ) : (
          <AgentActivityLabel
            agent={activity.sourceAgent}
            className="w-full"
            scheduledFallback={activity.sourceAgent === agent}
            linkToTurn
            onNavigate={onNavigate}
          />
        )}
      </div>
      {!projectId && repoName && !agent.reconnect ? (
        <RepoLabel agentId={agent.id} name={repoName} />
      ) : null}
    </div>
  );
}
