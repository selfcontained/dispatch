import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAgentRecord } from "@/hooks/use-agent-tree";
import { useProjectScope } from "@/hooks/use-projects";
import { agentRoute } from "@/lib/agent-routes";
import { cn } from "@/lib/utils";

/** A passive identity opens the exact session, independent of its tree or name. */
export function AgentSessionLink({
  agentId,
  name,
  projectId,
  children,
  className,
  decorative = true,
}: {
  agentId: string;
  name?: string | null;
  projectId?: string | null;
  /** An avatar or other decorative identity; omitted for the current name. */
  children?: ReactNode;
  className?: string;
  decorative?: boolean;
}) {
  const agent = useAgentRecord(agentId);
  const scope = useProjectScope();
  const label = agent?.name?.trim() || name?.trim() || "Agent";
  const project =
    projectId !== undefined ? projectId : (agent?.projectId ?? scope.projectId);
  const query = new URLSearchParams({ project: project ?? "" });
  return (
    <Link
      to={`${agentRoute(agentId)}?${query}`}
      aria-label={`Open ${label} session`}
      className={cn(
        "rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        className
      )}
      draggable={false}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      {children ? (
        <span aria-hidden={decorative || undefined} className="contents">
          {children}
        </span>
      ) : (
        label
      )}
    </Link>
  );
}
