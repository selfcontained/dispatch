import { useEffect } from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { useAgentRecord } from "@/hooks/use-agent-tree";
import { useChatLocation } from "@/hooks/use-chat-location";
import { agentHistoryRoute, agentRoute } from "@/lib/agent-routes";
import {
  ConversationReturnLink,
  conversationLocation,
} from "./chat/conversation-location-link";

export function AgentChatNavigation({
  agentId,
  parentId,
}: {
  agentId: string | null;
  parentId: string | null;
}) {
  return (
    <>
      <LegacyLocationRedirect agentId={agentId} />
      <ConversationReturnLink />
      {agentId && parentId ? (
        <LegacyHistory agentId={agentId} parentId={parentId} />
      ) : null}
    </>
  );
}

// Read legacy history in its actual container; never mark that feed read here.
function LegacyHistory({
  agentId,
  parentId,
}: {
  agentId: string;
  parentId: string;
}) {
  const { data: launch } = useChatLocation(agentId);
  const owner = useAgentRecord(launch?.streamId ?? null);
  return (
    <div className="flex gap-3 border-b px-3 py-1 text-xs text-muted-foreground">
      <Link to={agentRoute(parentId)}>Parent home</Link>
      {launch ? (
        <Link
          to={`${owner?.archived ? agentHistoryRoute(launch.streamId) : agentRoute(launch.streamId)}?thread=${launch.blockId}`}
        >
          Earlier launch history
        </Link>
      ) : null}
    </div>
  );
}

/** Repair old filtered-child URLs while preserving the stored message anchor. */
function LegacyLocationRedirect({ agentId }: { agentId: string | null }) {
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const blockId =
    params.get("finding") ?? params.get("thread") ?? params.get("block");
  const { data: target } = useChatLocation(
    blockId ? agentId : null,
    blockId ?? undefined
  );
  const owner = useAgentRecord(target?.streamId ?? null);
  const ownerLoaded = owner !== null;
  const archived = owner?.archived === true;
  useEffect(() => {
    if (!target || target.streamId === agentId || !ownerLoaded) return;
    const next = new URLSearchParams(location.search);
    if (!next.has("thread") && target.threadId)
      next.set("thread", target.threadId);
    const pathname = conversationLocation(target, archived).pathname;
    if (location.pathname === pathname && location.search === `?${next}`)
      return;
    navigate(
      {
        pathname,
        search: `?${next}`,
      },
      { replace: true }
    );
  }, [
    agentId,
    location.pathname,
    location.search,
    navigate,
    ownerLoaded,
    archived,
    target,
  ]);
  return null;
}
