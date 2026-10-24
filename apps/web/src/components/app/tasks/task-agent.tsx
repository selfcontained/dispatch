import type { Agent } from "@/components/app/types";
import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import { AgentActivityLabel } from "@/components/app/agent-activity";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

/** Each engine's tint, as the composer's provider cards wear it. */
const ENGINE_CHIP: Record<string, string> = {
  codex:
    "border-engine-codex/35 bg-engine-codex/10 [&>span:first-child]:text-engine-codex",
  claude:
    "border-engine-claude/35 bg-engine-claude/10 [&>span:first-child]:text-engine-claude",
};

export function TaskAgentChip({
  agent,
  compact = false,
  className,
}: {
  agent: Agent;
  compact?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 rounded-full border border-border/60 bg-muted/50 py-0.5 pl-0.5 pr-2 text-xs",
        ENGINE_CHIP[agent.type ?? "claude"],
        className
      )}
    >
      <AgentTypeIcon
        type={agent.type ?? "claude"}
        className="h-4 w-4 rounded-full border-0 bg-transparent"
      />
      <span className="max-w-28 truncate">{agent.name}</span>
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
  projectId,
  compact = false,
}: {
  agent?: Agent;
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
      <TaskAgentChip agent={agent} compact={compact} />
    </Link>
  );
}
