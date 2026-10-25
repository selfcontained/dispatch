import type { Agent } from "@/components/app/types";
import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import { TurnGlyph } from "@/components/app/chat/turn/activity-block";
import { useAgentActivity } from "@/hooks/use-agent-activity";
import { cachedAgentLineage } from "@/lib/agent-lineage";
import { ActivityBars } from "@/components/ui/activity-bars";
import { Clock } from "lucide-react";
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
  /** Fill the row, so a step has the width and cards line up. */
  fullWidth?: boolean;
  className?: string;
}) {
  const childAgents = agents
    ? cachedAgentLineage(agents).subAgentsByCardId.get(agent.id)
    : undefined;
  const activity = useAgentActivity(agent, childAgents);
  const live = activity.glyph !== "none";
  const qualifier = agentQualifier(agent, agents);
  return (
    <span
      className={cn(
        // Tinted by state, so colour on a card says something: green while
        // the agent starts or works, amber waiting on someone, red blocked,
        // quiet when idle, faded and dashed once it has stopped.
        "inline-flex min-w-0 items-center gap-2 rounded-full border py-1 pl-1 pr-3 text-xs text-foreground shadow-sm",
        activity.tone === "working" || activity.tone === "starting"
          ? "border-status-working/40 bg-status-working/10"
          : activity.tone === "waiting"
            ? "border-status-waiting/40 bg-status-waiting/10"
            : activity.tone === "blocked"
              ? "border-status-blocked/40 bg-status-blocked/10"
              : activity.tone === "archiving"
                ? "border-orange-400/40 bg-orange-400/10 text-orange-400"
                : activity.tone === "stopped"
                  ? "border-dashed border-border bg-transparent text-muted-foreground"
                  : "border-border bg-background/70",
        fullWidth && "w-full",
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
          aria-label={activity.label ?? activity.tone}
          role="img"
        >
          {activity.glyph === "bars" ? (
            <ActivityBars size={12} />
          ) : activity.glyph === "clock" ? (
            <Clock className="h-3 w-3" />
          ) : (
            <TurnGlyph
              summary={{ done: false, failed: false, interrupted: false }}
            />
          )}
        </span>
      )}
      {!compact && activity.label && (
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[10px] font-medium",
            activity.tone === "working" || activity.tone === "starting"
              ? "text-status-working"
              : activity.tone === "archiving"
                ? "text-orange-400"
                : activity.tone === "waiting"
                  ? "text-status-waiting"
                  : "text-muted-foreground"
          )}
        >
          {activity.sourceAgent !== agent
            ? `↳ ${activity.sourceAgent.name} · ${activity.label}`
            : activity.label}
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
