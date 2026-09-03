import { AGENT_RELATION_LABEL, type AgentRelation } from "@/lib/agent-lineage";
import { cn } from "@/lib/utils";

/**
 * "child agent" / "parent" / "sibling" / "agent": how a peer stands to the
 * agent whose feed or thread it appears in. The same chip in the chat feed
 * and the Messages panel, so a peer reads the same way in both.
 */
export function AgentRelationBadge({
  relation,
  className,
}: {
  relation: AgentRelation;
  className?: string;
}): JSX.Element {
  return (
    <span
      className={cn(
        "shrink-0 rounded border border-violet-500/30 bg-violet-500/10 px-1 text-[10px] font-medium leading-4 text-violet-600 dark:text-violet-300",
        className
      )}
      data-testid="agent-relation-badge"
      data-relation={relation}
    >
      {AGENT_RELATION_LABEL[relation]}
    </span>
  );
}
