import type { AgentActivity } from "@dispatch/shared";

import { type Agent } from "@/components/app/types";
import { agentActivity } from "@/lib/agent-activity";
import { ActivityBars } from "@/components/ui/activity-bars";
import { useAgentTurnLabel } from "@/hooks/use-agent-turn-label";
import { cn } from "@/lib/utils";

/** Idle has no word: an agent with nothing going on says nothing. */
const LABEL: Record<AgentActivity, string | null> = {
  starting: "Starting…",
  working: "Working",
  waiting: "Waiting",
  blocked: "Blocked",
  stopped: "Stopped",
  idle: null,
};

const COLOR: Record<AgentActivity, string> = {
  starting: "text-status-working",
  working: "text-status-working",
  waiting: "text-status-waiting",
  blocked: "text-status-blocked",
  stopped: "text-muted-foreground",
  idle: "text-muted-foreground",
};

/**
 * The status word for the agent's activity, in its colour, with what a
 * running turn is doing after it. Renders nothing while the agent is idle.
 */
export function AgentActivityLabel({
  agent,
  className,
}: {
  agent: Agent;
  className?: string;
}): JSX.Element | null {
  const activity = agentActivity(agent);
  const turnLabel = useAgentTurnLabel(agent.id);
  const label = LABEL[activity];
  if (!label) return null;
  const detail = activity === "working" ? turnLabel : null;
  return (
    <div
      className={cn("flex min-w-0 items-center gap-1.5", className)}
      data-testid={`agent-activity-${agent.id}`}
      data-activity={activity}
    >
      {activity === "starting" || activity === "working" ? (
        <ActivityBars size={12} className={cn("shrink-0", COLOR[activity])} />
      ) : null}
      <span className={cn("shrink-0 font-medium", COLOR[activity])}>
        {label}
      </span>
      {detail ? (
        <span className="min-w-0 truncate text-muted-foreground">{detail}</span>
      ) : null}
    </div>
  );
}
