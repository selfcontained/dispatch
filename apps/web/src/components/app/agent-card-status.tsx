import React from "react";

import { AgentActivityLabel } from "@/components/app/agent-activity";
import { type Agent } from "@/components/app/types";
import { ActivityBars } from "@/components/ui/activity-bars";

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
 * Archive progress shown under the card header while the agent is torn
 * down. Setup has no lines of its own here: the card says "Starting…" and
 * the stream's workspace block carries the detail.
 */
export function AgentCardPhaseStatus({
  agent,
}: {
  agent: Agent;
}): JSX.Element | null {
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
 * The agent's activity, as the server derives it, beside the repo it works
 * in. Hidden while archiving, which has its own progress line.
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
  const repoName = agent.gitContext
    ? (agent.gitContext.repoRoot.split("/").pop() ?? null)
    : (agent.cwd.split("/").pop() ?? null);

  return (
    <div className="mt-1 flex min-h-4 min-w-0 items-center text-xs text-muted-foreground">
      <AgentActivityLabel agent={agent} linkToTurn onNavigate={onNavigate} />
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
