import React from "react";

import {
  latestEventLabel,
  latestEventColor,
} from "@/components/app/agent-event-utils";
import { type Agent } from "@/components/app/types";
import { ActivityBars } from "@/components/ui/activity-bars";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

function RepoLabel({
  agentId,
  repoIconPath,
  name,
}: {
  agentId: string;
  repoIconPath?: string | null;
  name: string;
}) {
  const [iconError, setIconError] = React.useState(false);
  const showIcon = !!repoIconPath && !iconError;

  return (
    <span className="ml-auto flex min-w-0 items-center gap-1 pl-2">
      {showIcon ? (
        <img
          src={`/api/v1/agents/${agentId}/repo-icon`}
          alt=""
          className="h-5 w-5 shrink-0 rounded-sm object-contain"
          onError={() => setIconError(true)}
        />
      ) : null}
      <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground/60">
        {name}
      </span>
    </span>
  );
}

/**
 * Transient setup/archive progress lines shown under the card header while the
 * agent is being created or torn down.
 */
export function AgentCardPhaseStatus({
  agent,
}: {
  agent: Agent;
}): JSX.Element | null {
  if (agent.status === "creating" && agent.setupPhase) {
    return (
      <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-status-working">
        <ActivityBars size={12} className="shrink-0" />
        <span className="truncate font-medium">
          {agent.setupPhase === "worktree"
            ? "Creating worktree…"
            : agent.setupPhase === "env"
              ? "Copying environment…"
              : agent.setupPhase === "deps"
                ? "Installing dependencies…"
                : agent.setupPhase === "session"
                  ? "Starting session…"
                  : "Setting up…"}
        </span>
      </div>
    );
  }

  if (agent.status === "archiving") {
    return (
      <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-orange-400">
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

function LatestEventSummary({
  agent,
  event,
  className,
}: {
  agent: Agent;
  event: NonNullable<Agent["latestEvent"]>;
  className: string;
}): JSX.Element {
  const repoName = agent.gitContext
    ? (agent.gitContext.repoRoot.split("/").pop() ?? null)
    : (agent.cwd.split("/").pop() ?? null);

  return (
    <div className={className}>
      <span
        className={cn("shrink-0 font-medium", latestEventColor(event.type))}
      >
        {latestEventLabel(event.type)}
      </span>
      <span className="mx-1.5 shrink-0 text-muted-foreground/70">•</span>
      <span className="shrink-0">{formatRelativeTime(event.updatedAt)}</span>
      {repoName ? (
        <RepoLabel
          agentId={agent.id}
          repoIconPath={agent.gitContext?.repoIconPath}
          name={repoName}
        />
      ) : null}
    </div>
  );
}

/**
 * The agent's most recent status event. Expanded cards also show the event
 * message below the summary line.
 */
export function AgentCardLatestEvent({
  agent,
  isExpanded,
}: {
  agent: Agent;
  isExpanded: boolean;
}): JSX.Element | null {
  const event = agent.latestEvent;
  if (!event) return null;

  if (isExpanded) {
    return (
      <div className="mt-1 text-xs text-muted-foreground">
        <LatestEventSummary
          agent={agent}
          event={event}
          className="flex items-baseline"
        />
        <div className="mt-0.5 leading-relaxed text-muted-foreground">
          {event.message}
        </div>
      </div>
    );
  }

  return (
    <LatestEventSummary
      agent={agent}
      event={event}
      className="mt-1 flex min-w-0 items-baseline text-xs text-muted-foreground"
    />
  );
}
