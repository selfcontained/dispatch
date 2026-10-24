import type { Agent } from "@/components/app/types";
import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import { TurnGlyph } from "@/components/app/chat/turn/activity-block";
import { useAgentTurnLabel } from "@/hooks/use-agent-turn-label";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { agentQualifier } from "./task-utils";

/**
 * An agent on a task. While the agent is in a turn the chip carries the
 * same live glyph the sidebar and its turns show, and (unless compact)
 * the step it is on, so a glance at the board says who is working.
 */
export function TaskAgentChip({
  agent,
  agents,
  compact = false,
  fullWidth = false,
  className,
}: {
  agent: Agent;
  /** The agents it sits among, so a shared name says when it started. */
  agents?: readonly Agent[];
  compact?: boolean;
  /** Fill the row while a step is showing, so it has the width. */
  fullWidth?: boolean;
  className?: string;
}) {
  const turn = agent.currentTurn ?? null;
  const step = useAgentTurnLabel(agent.id, turn?.blockId ?? null);
  const live = agent.activity === "working" || Boolean(turn);
  const attention =
    agent.activity === "waiting" || agent.activity === "blocked";
  const qualifier = agentQualifier(agent, agents);
  return (
    <span
      className={cn(
        // Tinted by state, so colour on a card says something: green while
        // the agent works, amber when it waits on someone, quiet otherwise.
        "inline-flex min-w-0 items-center gap-2 rounded-full border py-1 pl-1 pr-3 text-xs text-foreground shadow-sm",
        live
          ? "border-status-working/40 bg-status-working/10"
          : attention
            ? "border-status-waiting/40 bg-status-waiting/10"
            : "border-border bg-background/70",
        fullWidth && live && !compact && step && "w-full",
        className
      )}
      title={
        qualifier
          ? `${agent.name} · started ${qualifier === "now" ? "just now" : `${qualifier} ago`}`
          : agent.name
      }
    >
      <AgentTypeIcon
        type={agent.type ?? "claude"}
        className="h-4.5 w-4.5 rounded-full border-0 bg-transparent"
      />
      <span className="max-w-28 truncate">{agent.name}</span>
      {qualifier && (
        <span className="truncate text-[10px] text-muted-foreground">
          · {qualifier}
        </span>
      )}
      {live && (
        <span
          className="flex w-3 shrink-0 items-center justify-center leading-none"
          data-testid={`task-agent-live-${agent.id}`}
          aria-label="Working"
          role="img"
        >
          <TurnGlyph
            summary={{ done: false, failed: false, interrupted: false }}
          />
        </span>
      )}
      {live && !compact && step && (
        <span className="min-w-0 flex-1 truncate text-[10px] font-medium text-status-working">
          {step}
        </span>
      )}
    </span>
  );
}

export function TaskAgent({
  agent,
  agents,
  projectId,
  compact = false,
  fullWidth = false,
}: {
  agent?: Agent;
  agents?: readonly Agent[];
  projectId: string;
  compact?: boolean;
  /** Fill the row, so a running step has the whole card's width. */
  fullWidth?: boolean;
}) {
  if (!agent)
    return <span className="text-xs text-muted-foreground">Unassigned</span>;
  return (
    <Link
      to={`/agents/${agent.id}?project=${encodeURIComponent(projectId)}`}
      onClick={(event) => event.stopPropagation()}
      className={cn(
        "inline-flex min-w-0 rounded-full hover:brightness-125",
        fullWidth && "w-full"
      )}
    >
      <TaskAgentChip
        agent={agent}
        agents={agents}
        compact={compact}
        fullWidth={fullWidth}
      />
    </Link>
  );
}
