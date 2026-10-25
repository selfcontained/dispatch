import type { Agent } from "@/components/app/types";
import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import { TurnGlyph } from "@/components/app/chat/turn/activity-block";
import {
  type AgentActivity,
  type AgentActivityTone,
  useAgentActivity,
} from "@/hooks/use-agent-activity";
import { cachedAgentLineage } from "@/lib/agent-lineage";
import { ActivityBars } from "@/components/ui/activity-bars";
import { Clock } from "lucide-react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { agentQualifier } from "./task-utils";

const STATE_LABELS: Record<AgentActivityTone, string> = {
  starting: "Starting…",
  working: "Working",
  waiting: "Waiting",
  blocked: "Blocked",
  idle: "Idle",
  stopped: "Stopped",
  archiving: "Archiving…",
};

/**
 * The activity's glyph. Alone (compact) it carries the activity as its
 * accessible name, child included; beside the activity text it is decorative.
 */
function ActivityGlyph({
  agent,
  activity,
  label,
}: {
  agent: Agent;
  activity: AgentActivity;
  /** The accessible name, or null when adjacent text already says it. */
  label: string | null;
}) {
  if (activity.glyph === "none") return null;
  return (
    <span
      className="flex w-3 shrink-0 items-center justify-center leading-none"
      data-testid={`task-agent-live-${agent.id}`}
      {...(label
        ? { role: "img", "aria-label": label }
        : { "aria-hidden": true })}
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
  );
}

/**
 * An agent on a task, showing what the sidebar would: its phase or step,
 * else a child's step, else its next schedule. On cards and the drawer the
 * activity has a row of its own, kept when there is nothing to report so a
 * card does not change height as agents start and stop; compact hosts (list
 * rows, the assignee picker) keep one row with the glyph alone.
 */
export function TaskAgentChip({
  agent,
  agents,
  compact = false,
  fullWidth = false,
  className,
}: {
  agent: Agent;
  /** The agents it sits among, for its children and a shared name's age. */
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
  const qualifier = agentQualifier(agent, agents);
  const activityText = !activity.label
    ? null
    : activity.sourceAgent !== agent
      ? `↳ ${activity.sourceAgent.name} · ${activity.label}`
      : activity.label;
  const name = qualifier
    ? `${agent.name} · started ${qualifier === "now" ? "just now" : `${qualifier} ago`}`
    : agent.name;
  const live = activity.tone === "working" || activity.tone === "starting";
  const nameRow = (
    <>
      <AgentTypeIcon
        type={agent.type ?? "claude"}
        className="h-4.5 w-4.5 shrink-0 rounded-full border-0 bg-transparent"
      />
      <span className={cn("min-w-0 truncate", compact && "max-w-28")}>
        {agent.name}
      </span>
      {qualifier && (
        <span className="shrink-0 text-[10px] text-muted-foreground">
          · {qualifier}
        </span>
      )}
    </>
  );
  return (
    <span
      className={cn(
        // Tinted by state, so colour on a card says something: green while
        // the agent starts or works, amber waiting on someone, red blocked,
        // orange archiving, quiet when idle, faded and dashed once stopped.
        "inline-flex min-w-0 border text-xs text-foreground shadow-sm",
        compact
          ? "items-center gap-2 rounded-full py-1 pl-1 pr-3"
          : "flex-col gap-1 rounded-lg px-2 py-1.5",
        live
          ? "border-status-working/40 bg-status-working/10"
          : activity.tone === "waiting"
            ? "border-status-waiting/40 bg-status-waiting/10"
            : activity.tone === "blocked"
              ? "border-status-blocked/40 bg-status-blocked/10"
              : activity.tone === "archiving"
                ? "border-orange-400/40 bg-orange-400/10"
                : activity.tone === "stopped"
                  ? "border-dashed border-border bg-transparent text-muted-foreground"
                  : "border-border bg-background/70",
        fullWidth && "w-full",
        className
      )}
      data-testid={`task-agent-chip-${agent.id}`}
      data-layout={compact ? "compact" : "stacked"}
      title={activityText ? `${name}\n${activityText}` : name}
    >
      {compact ? (
        <>
          {nameRow}
          <ActivityGlyph
            agent={agent}
            activity={activity}
            label={activityText ?? STATE_LABELS[activity.tone]}
          />
        </>
      ) : (
        <>
          <span className="flex min-w-0 items-center gap-2">{nameRow}</span>
          <span
            className={cn(
              "flex min-h-4 min-w-0 items-center gap-1.5 text-[10px] font-medium",
              activity.kind === "schedule"
                ? // The sidebar's colour for the next scheduled message.
                  "text-heading-accent-1"
                : live
                  ? "text-status-working"
                  : activity.tone === "archiving"
                    ? "text-orange-400"
                    : activity.tone === "waiting"
                      ? "text-status-waiting"
                      : activity.tone === "blocked"
                        ? "text-status-blocked"
                        : "text-muted-foreground"
            )}
            data-testid={`task-agent-activity-${agent.id}`}
          >
            <ActivityGlyph agent={agent} activity={activity} label={null} />
            <span className="min-w-0 truncate">
              {activityText ?? STATE_LABELS[activity.tone]}
            </span>
          </span>
        </>
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
        "inline-flex min-w-0 hover:brightness-125",
        compact ? "rounded-full" : "rounded-lg",
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
