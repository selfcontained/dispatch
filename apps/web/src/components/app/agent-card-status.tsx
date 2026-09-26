import React from "react";

import { AgentActivityLabel } from "@/components/app/agent-activity";
import { type Agent } from "@/components/app/types";
import { agentProjectRoot } from "@/components/app/agents-view-utils";
import { ActivityBars } from "@/components/ui/activity-bars";

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
}: {
  agent: Agent;
}): JSX.Element | null {
  if (agent.status === "creating" || agent.setupPhase) {
    return (
      <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-status-working">
        <ActivityBars size={12} className="shrink-0" />
        <span className="truncate font-medium">Starting…</span>
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

/**
 * The current turn's reported step above the repo it works in. Archive
 * progress has its own line.
 */
export function AgentCardActivity({
  agent,
  onNavigate,
}: {
  agent: Agent;
  /** Called as the running-turn link navigates. */
  onNavigate?: () => void;
}): JSX.Element | null {
  if (agent.status === "archiving") return null;
  const repoName = agentProjectRoot(agent)?.split("/").pop() ?? null;

  return (
    <div className="mt-1 flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
      <AgentActivityLabel
        agent={agent}
        className="w-full"
        linkToTurn
        onNavigate={onNavigate}
      />
      {repoName && !agent.reconnect ? (
        <RepoLabel agentId={agent.id} name={repoName} />
      ) : null}
    </div>
  );
}
