import type { Agent } from "@/components/app/types";
import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import { TurnGlyph } from "@/components/app/chat/turn/activity-block";
import {
  type AgentActivity,
  type AgentActivityTone,
  useAgentActivity,
} from "@/hooks/use-agent-activity";
import { cachedAgentLineage } from "@/lib/agent-lineage";
import { useAgentName, useAgentRecord } from "@/hooks/use-agent-tree";
import { ActivityBars } from "@/components/ui/activity-bars";
import { StatusDot, type StatusDotTone } from "@/components/ui/status-dot";
import { Hint } from "@/components/ui/tooltip";
import { Clock } from "lucide-react";
import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { AgentSessionLink } from "@/components/app/agent-session-link";
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

const STATE_DOT: Record<AgentActivityTone, StatusDotTone> = {
  starting: "working",
  working: "working",
  waiting: "waiting",
  blocked: "blocked",
  idle: "idle",
  stopped: "neutral",
  archiving: "warning",
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
 * The one way an agent looks on a task: avatar, name, state, at two sizes.
 * Compact hosts keep the first row alone.
 */
const AgentChipFrame = forwardRef<
  HTMLSpanElement,
  HTMLAttributes<HTMLSpanElement> & {
    type?: string | null;
    name: string;
    qualifier?: string | null;
    compact: boolean;
    fullWidth: boolean;
    indicator: ReactNode;
    /** The second row, at the larger size. */
    detail: ReactNode;
  }
>(
  (
    {
      type,
      name,
      qualifier,
      compact,
      fullWidth,
      indicator,
      detail,
      className,
      ...props
    },
    ref
  ) => {
    const nameRow = (
      <>
        <AgentTypeIcon
          type={type ?? "claude"}
          className="h-4.5 w-4.5 shrink-0 rounded-full border-0 bg-transparent"
        />
        <span className={cn("min-w-0 truncate", compact && "max-w-28")}>
          {name}
        </span>
        {qualifier ? (
          <span className="shrink-0 text-label-xs text-muted-foreground">
            · {qualifier}
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center">{indicator}</span>
      </>
    );
    return (
      <span
        ref={ref}
        className={cn(
          "inline-flex min-w-0 rounded-md border px-2 text-body-sm text-foreground shadow-sm",
          compact ? "items-center gap-2 py-1" : "flex-col gap-1 py-1.5",
          fullWidth && "w-full",
          className
        )}
        data-layout={compact ? "compact" : "stacked"}
        {...props}
      >
        {compact ? (
          nameRow
        ) : (
          <>
            <span className="flex min-w-0 items-center gap-2">{nameRow}</span>
            {detail}
          </>
        )}
      </span>
    );
  }
);
AgentChipFrame.displayName = "AgentChipFrame";

/**
 * An agent the live list doesn't have, almost always archived: still the
 * assignee, so still named, in the same chip.
 */
export function UnlistedTaskAgentChip({
  agentId,
  compact = false,
  fullWidth = false,
  className,
}: {
  agentId: string;
  compact?: boolean;
  fullWidth?: boolean;
  className?: string;
}) {
  const name = useAgentName(agentId);
  const record = useAgentRecord(agentId);
  const state = record?.archived ? "Archived" : null;
  return (
    <Hint label={state ? `${name}\n${state}` : name}>
      <AgentChipFrame
        type={record?.type}
        name={name}
        compact={compact}
        fullWidth={fullWidth}
        data-testid={`task-agent-chip-${agentId}`}
        className={cn(
          "border-dashed border-border bg-transparent text-muted-foreground",
          className
        )}
        indicator={
          <StatusDot
            tone="neutral"
            {...(compact && state
              ? { role: "img", "aria-hidden": false, "aria-label": state }
              : {})}
          />
        }
        detail={
          <span className="flex min-h-4 min-w-0 items-center text-label-xs font-medium text-muted-foreground">
            {state}
          </span>
        }
      />
    </Hint>
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
  const state = activityText ?? STATE_LABELS[activity.tone];
  return (
    <Hint label={activityText ? `${name}\n${activityText}` : name}>
      <AgentChipFrame
        type={agent.type}
        name={agent.name}
        qualifier={qualifier}
        compact={compact}
        fullWidth={fullWidth}
        data-testid={`task-agent-chip-${agent.id}`}
        // Tinted by state, so colour on a card says something: green while
        // the agent starts or works, amber waiting on someone, red blocked,
        // orange archiving, quiet when idle, faded and dashed once stopped.
        className={cn(
          live
            ? "border-status-working/line bg-status-working/tint"
            : activity.tone === "waiting"
              ? "border-status-waiting/line bg-status-waiting/tint"
              : activity.tone === "blocked"
                ? "border-status-blocked/line bg-status-blocked/tint"
                : activity.tone === "archiving"
                  ? "border-warning/line bg-warning/tint"
                  : activity.tone === "stopped"
                    ? "border-dashed border-border bg-transparent text-muted-foreground"
                    : "border-border bg-background/soft",
          className
        )}
        indicator={
          compact && activity.glyph !== "none" ? (
            <ActivityGlyph agent={agent} activity={activity} label={state} />
          ) : (
            <StatusDot
              tone={STATE_DOT[activity.tone]}
              {...(compact
                ? { role: "img", "aria-hidden": false, "aria-label": state }
                : {})}
            />
          )
        }
        detail={
          <span
            className={cn(
              "flex min-h-4 min-w-0 items-center gap-1.5 text-label-xs font-medium",
              activity.kind === "schedule"
                ? // The sidebar's colour for the next scheduled message.
                  "text-heading-accent-1"
                : live
                  ? "text-status-working"
                  : activity.tone === "archiving"
                    ? "text-warning"
                    : activity.tone === "waiting"
                      ? "text-status-waiting"
                      : activity.tone === "blocked"
                        ? "text-status-blocked"
                        : "text-muted-foreground"
            )}
            data-testid={`task-agent-activity-${agent.id}`}
          >
            <ActivityGlyph agent={agent} activity={activity} label={null} />
            <span className="min-w-0 truncate">{state}</span>
          </span>
        }
      />
    </Hint>
  );
}

export function TaskAgent({
  agent,
  agentId,
  agents,
  projectId,
  compact = false,
  fullWidth = false,
}: {
  agent?: Agent;
  /** Who is assigned, also when the live list has no such agent. */
  agentId: string | null;
  agents?: readonly Agent[];
  projectId: string;
  compact?: boolean;
  /** Fill the row, so a running step has the whole card's width. */
  fullWidth?: boolean;
}) {
  if (!agentId)
    return (
      <span className="text-body-sm text-muted-foreground">Unassigned</span>
    );
  return (
    <AgentSessionLink
      decorative={false}
      agentId={agentId}
      name={agent?.name}
      projectId={projectId}
      className={cn(
        "inline-flex min-w-0 rounded-md hover:brightness-125",
        fullWidth && "w-full"
      )}
    >
      {agent ? (
        <TaskAgentChip
          agent={agent}
          agents={agents}
          compact={compact}
          fullWidth={fullWidth}
        />
      ) : (
        <UnlistedTaskAgentChip
          agentId={agentId}
          compact={compact}
          fullWidth={fullWidth}
        />
      )}
    </AgentSessionLink>
  );
}
