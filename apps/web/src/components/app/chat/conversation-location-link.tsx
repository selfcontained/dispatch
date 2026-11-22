import type { ChatTurnEntry } from "@dispatch/shared";
import { CornerUpLeft } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { useAgentRecord } from "@/hooks/use-agent-tree";
import { agentHistoryRoute, agentRoute } from "@/lib/agent-routes";
import { AgentSessionLink } from "../agent-session-link";

export const RETURN_AGENT_PARAM = "returnAgent";

export function conversationLocation(
  source: NonNullable<ChatTurnEntry["sourceConversation"]>,
  archived: boolean,
  returnAgentId?: string
) {
  const task = source.streamId.startsWith("tsk_");
  const params = new URLSearchParams();
  if (task) {
    params.set("task", source.streamId);
    params.set("pane", "conversation");
  }
  if (source.threadId) params.set("thread", source.threadId);
  if (source.blockId) params.set("block", source.blockId);
  if (returnAgentId) params.set(RETURN_AGENT_PARAM, returnAgentId);
  return {
    pathname: task
      ? "/tasks"
      : archived
        ? agentHistoryRoute(source.streamId)
        : agentRoute(source.streamId),
    search: params.size ? `?${params}` : "",
  };
}

export function ConversationLocationLink({
  turn,
  homeId,
  threadId = null,
}: {
  turn: ChatTurnEntry;
  homeId: string;
  threadId?: string | null;
}) {
  const source = turn.sourceConversation;
  const record = useAgentRecord(
    source && !source.streamId.startsWith("tsk_") ? source.streamId : null
  );
  if (
    !source ||
    turn.prompt.source !== "agent" ||
    !turn.prompt.senderAgentId ||
    turn.prompt.senderAgentId === turn.agentId ||
    (!source.streamId.startsWith("tsk_") && !record) ||
    (source.streamId === homeId && source.threadId === threadId)
  )
    return null;
  const destinationLabel = source.blockId
    ? "View original message"
    : source.threadId
      ? "View original discussion"
      : "View original conversation";
  return (
    <Link
      data-testid="turn-source-discussion"
      aria-label={`Source: ${destinationLabel}`}
      title={destinationLabel}
      className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-primary/line bg-primary/wash px-1 text-label-xs font-normal leading-4 text-primary transition-colors hover:border-primary/line-strong hover:bg-surface-selected focus-ring"
      to={conversationLocation(source, record?.archived === true, homeId)}
    >
      <CornerUpLeft aria-hidden="true" className="size-3" />
      Source
    </Link>
  );
}

/** A source discussion remains in its actual container; this returns to work. */
export function ConversationReturnLink({
  inDrawer = false,
}: { inDrawer?: boolean } = {}) {
  const [params] = useSearchParams();
  const agentId = params.get(RETURN_AGENT_PARAM);
  if (params.has("thread") && !inDrawer) return null;
  return agentId ? (
    <div className="border-b px-3 py-1 text-body-sm text-muted-foreground">
      <AgentSessionLink agentId={agentId}>Back to agent home</AgentSessionLink>
    </div>
  ) : null;
}
