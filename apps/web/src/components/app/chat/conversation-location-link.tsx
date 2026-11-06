import type { ChatTurnEntry } from "@dispatch/shared";
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
}: {
  turn: ChatTurnEntry;
  homeId: string;
}) {
  const source = turn.sourceConversation;
  const record = useAgentRecord(
    source && !source.streamId.startsWith("tsk_") ? source.streamId : null
  );
  if (!source || (source.streamId === homeId && source.threadId === null))
    return null;
  return (
    <Link
      data-testid="turn-source-discussion"
      className="mb-1 inline-flex min-h-8 items-center text-xs text-muted-foreground hover:underline"
      to={conversationLocation(source, record?.archived === true, homeId)}
    >
      Open source discussion
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
    <div className="border-b px-3 py-1 text-xs text-muted-foreground">
      <AgentSessionLink agentId={agentId}>Back to agent home</AgentSessionLink>
    </div>
  ) : null;
}
