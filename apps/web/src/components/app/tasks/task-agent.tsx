import type { Agent } from "@/components/app/types";
import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import { AgentActivityLabel } from "@/components/app/agent-activity";
import { Link } from "react-router-dom";
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
      className="inline-flex min-w-0 items-center gap-1.5 rounded-md border border-border/60 bg-background/40 px-1.5 py-0.5 text-xs hover:bg-muted"
    >
      <AgentTypeIcon type={agent.type ?? "claude"} className="h-3.5 w-3.5" />
      <span className="max-w-28 truncate">{agent.name}</span>
      {!compact && (
        <AgentActivityLabel
          agent={agent}
          className="max-w-24 truncate text-[10px] text-muted-foreground"
        />
      )}
    </Link>
  );
}
