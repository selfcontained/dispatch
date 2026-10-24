import type { Agent } from "@/components/app/types";
import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import { AgentActivityLabel } from "@/components/app/agent-activity";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { agentQualifier } from "./task-utils";

/** Each engine's tint, as the composer's provider cards wear it. */
const ENGINE_CHIP: Record<string, string> = {
  codex:
    "border-engine-codex/35 bg-engine-codex/10 [&>span:first-child]:text-engine-codex",
  claude:
    "border-engine-claude/35 bg-engine-claude/10 [&>span:first-child]:text-engine-claude",
};

/**
 * The agent's state as the sidebar colours it: working pulses green, a
 * question or block waits in amber, idle is quiet, stopped is hollow.
 */
const ACTIVITY_DOT: Record<
  NonNullable<Agent["activity"]>,
  { className: string; label: string }
> = {
  starting: { className: "bg-status-working animate-pulse", label: "Starting" },
  working: { className: "bg-status-working animate-pulse", label: "Working" },
  waiting: { className: "bg-status-waiting", label: "Waiting on you" },
  blocked: { className: "bg-status-blocked", label: "Blocked" },
  idle: { className: "bg-status-idle", label: "Idle" },
  stopped: {
    className: "border border-muted-foreground/60 bg-transparent",
    label: "Stopped",
  },
};

export function TaskAgentChip({
  agent,
  agents,
  compact = false,
  className,
}: {
  agent: Agent;
  /** The agents it sits among, so a shared name gets its id tail. */
  agents?: readonly Agent[];
  compact?: boolean;
  className?: string;
}) {
  const dot = ACTIVITY_DOT[agent.activity ?? "stopped"];
  const qualifier = agentQualifier(agent, agents);
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 rounded-full border border-border/60 bg-muted/50 py-0.5 pl-0.5 pr-2 text-xs",
        ENGINE_CHIP[agent.type ?? "claude"],
        className
      )}
      title={`${agent.name}${qualifier ? ` (${agent.id})` : ""} · ${dot.label}`}
    >
      <span className="relative inline-flex shrink-0">
        <AgentTypeIcon
          type={agent.type ?? "claude"}
          className="h-4 w-4 rounded-full border-0 bg-transparent"
        />
        <span
          role="img"
          aria-label={dot.label}
          data-testid={`task-agent-activity-${agent.id}`}
          data-activity={agent.activity}
          className={cn(
            "absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-card",
            dot.className
          )}
        />
      </span>
      <span className="max-w-28 truncate">{agent.name}</span>
      {qualifier && (
        <span className="-ml-1 font-mono text-[10px] text-muted-foreground">
          {qualifier}
        </span>
      )}
      {!compact && (
        <AgentActivityLabel
          agent={agent}
          className="max-w-24 truncate text-[10px] text-muted-foreground"
        />
      )}
    </span>
  );
}

export function TaskAgent({
  agent,
  agents,
  projectId,
  compact = false,
}: {
  agent?: Agent;
  agents?: readonly Agent[];
  projectId: string;
  compact?: boolean;
}) {
  if (!agent)
    return <span className="text-xs text-muted-foreground">Unassigned</span>;
  return (
    <Link
      to={`/agents/${agent.id}?project=${encodeURIComponent(projectId)}`}
      onClick={(event) => event.stopPropagation()}
      className="inline-flex min-w-0 rounded-full hover:brightness-125"
    >
      <TaskAgentChip agent={agent} agents={agents} compact={compact} />
    </Link>
  );
}
