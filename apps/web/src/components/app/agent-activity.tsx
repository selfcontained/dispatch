import type { AgentActivity } from "@dispatch/shared";
import { CornerDownRight } from "lucide-react";

import { type Agent } from "@/components/app/types";
import { agentActivity } from "@/lib/agent-activity";
import { ActivityBars } from "@/components/ui/activity-bars";
import { useAgentTurnLabel } from "@/hooks/use-agent-turn-label";
import { useJumpToTurn } from "@/hooks/use-block-jump";
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
 *
 * With `linkToTurn`, a working agent's label is also the way to its
 * running turn: a click opens the agent's page scrolled to the turn (or
 * its thread open on it). It is marked as its own control so a sidebar
 * row's click — open or close the agent — is left as it was.
 */
export function AgentActivityLabel({
  agent,
  className,
  linkToTurn = false,
  onNavigate,
}: {
  agent: Agent;
  className?: string;
  linkToTurn?: boolean;
  /** Called as the link navigates (a mobile sidebar closes itself). */
  onNavigate?: () => void;
}): JSX.Element | null {
  const activity = agentActivity(agent);
  const turnLabel = useAgentTurnLabel(agent.id);
  const jumpToTurn = useJumpToTurn();
  const label = LABEL[activity];
  if (!label) return null;
  const detail = activity === "working" ? turnLabel : null;
  const turn =
    linkToTurn && activity === "working" ? (agent.currentTurn ?? null) : null;
  const content = (
    <>
      {activity === "starting" || activity === "working" ? (
        <ActivityBars size={12} className={cn("shrink-0", COLOR[activity])} />
      ) : null}
      <span className={cn("shrink-0 font-medium", COLOR[activity])}>
        {label}
      </span>
      {detail ? (
        <span className="min-w-0 truncate text-muted-foreground">{detail}</span>
      ) : null}
    </>
  );
  if (turn) {
    return (
      <button
        type="button"
        className={cn(
          "group/turn flex min-w-0 max-w-full items-center gap-1.5 rounded-sm text-left",
          "hover:underline decoration-muted-foreground/50 underline-offset-2",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          className
        )}
        data-testid={`agent-activity-${agent.id}`}
        data-activity={activity}
        data-agent-control="true"
        data-turn-link={turn.blockId}
        aria-label={`Go to ${agent.persona ?? agent.name}'s current turn`}
        title="Go to the current turn"
        onClick={(event) => {
          event.stopPropagation();
          onNavigate?.();
          jumpToTurn(agent.id, turn);
        }}
      >
        {content}
        <CornerDownRight
          aria-hidden="true"
          className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/turn:opacity-100 group-focus-visible/turn:opacity-100"
        />
      </button>
    );
  }
  return (
    <div
      className={cn("flex min-w-0 items-center gap-1.5", className)}
      data-testid={`agent-activity-${agent.id}`}
      data-activity={activity}
    >
      {content}
    </div>
  );
}
