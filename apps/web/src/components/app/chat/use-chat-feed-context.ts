import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  agentModelLabel,
  useAgentModelCatalogData,
} from "@/hooks/use-agent-model-catalog";

import {
  type FeedContext,
  type PeerDirectory,
  peerDirectory,
} from "@/components/app/chat/chat-entries";
import { type Agent } from "@/components/app/types";
import { lineageSeats } from "@/lib/agent-seat";
import { api } from "@/lib/api";

export type ChatFeedContextInput = {
  agentId: string | null;
  rootId?: string | null;
  agent: Agent | null;
  openLightbox: (fileId: number) => void;
  /** Must be stable: every row is memoised on the context it lands in. */
  onOpenPath?: FeedContext["onOpenPath"];
  onToggleReaction?: FeedContext["onToggleReaction"];
  onOpenThread?: FeedContext["onOpenThread"];
  onSubmitForm?: FeedContext["onSubmitForm"];
  onSetBlockState?: FeedContext["onSetBlockState"];
  onRetryDelivery?: FeedContext["onRetryDelivery"];
  onRetryTurn?: FeedContext["onRetryTurn"];
  /** Must keep its identity while nothing retries: the rows memo on it. */
  retrying?: FeedContext["retrying"];
};

export type ChatFeedContextResult = {
  /** Feed-wide identity: the memo key of every row. */
  ctx: FeedContext;
};

/**
 * The context the feed's rows read, built so that it keeps its identity
 * until something it carries actually changes.
 *
 * Every row is memoised on `ctx`, so the rules that keep it stable live
 * here, in one place:
 *
 * - `agent` is a fresh object on every `agent.upsert`; only the scalar
 *   fields the feed shows are dependencies, never the record.
 * - The peer directory comes from the agents query through a stable
 *   selector, so react-query hands back the previous value when nothing
 *   in it changed.
 * - Mutation result objects are new on every render; callbacks depend on
 *   the stable `mutate` and the `isPending` flag, never the object.
 */
export function useChatFeedContext({
  agentId,
  rootId = null,
  agent,
  openLightbox,
  onOpenPath,
  onToggleReaction,
  onOpenThread,
  onSubmitForm,
  onSetBlockState,
  onRetryDelivery,
  onRetryTurn,
  retrying,
}: ChatFeedContextInput): ChatFeedContextResult {
  // The sidebar's agent list, read for a peer post's icon and lineage.
  // `select` narrows it to what the feed shows, so structural sharing keeps
  // the directory's identity across agent updates that change nothing here;
  // a stable selector lets react-query skip re-running it at all.
  // One read of the list gives both: the peers, and this agent's own
  // seat in its tree (drawn as its avatar).
  const selectPeers = useCallback(
    (agents: Agent[]) => ({
      peers: peerDirectory(agentId ?? "", agents),
      seat: agentId ? (lineageSeats(agentId, agents)[agentId] ?? null) : null,
    }),
    [agentId]
  );
  const { data: directory } = useQuery<
    Agent[],
    Error,
    { peers: PeerDirectory; seat: number | null }
  >({
    queryKey: ["agents"],
    queryFn: async () => {
      const payload = await api<{ agents: Agent[] }>("/api/v1/agents");
      return payload.agents;
    },
    select: selectPeers,
  });
  const peers = directory?.peers;
  const agentSeat = directory?.seat ?? null;

  const agentName = agent?.name;
  const agentType = agent?.type ?? null;
  const agentModel = agent?.model ?? null;
  const catalog = useAgentModelCatalogData();
  const modelLabel = useCallback(
    (type: string | null, model: string) =>
      agentModelLabel(catalog, type, model),
    [catalog]
  );
  const ctx = useMemo<FeedContext>(
    () => ({
      agentId: agentId ?? "",
      rootId,
      agentName,
      agentType,
      agentModel,
      modelLabel,
      ...(agentSeat != null ? { agentSeat } : {}),
      peers,
      onOpenFile: openLightbox,
      onOpenPath,
      onToggleReaction,
      onOpenThread,
      onSubmitForm,
      onSetBlockState,
      onRetryDelivery,
      onRetryTurn,
      retrying,
    }),
    [
      agentId,
      rootId,
      agentName,
      agentType,
      agentModel,
      modelLabel,
      agentSeat,
      onOpenPath,
      onToggleReaction,
      onOpenThread,
      onSubmitForm,
      onSetBlockState,
      onRetryDelivery,
      onRetryTurn,
      retrying,
      openLightbox,
      peers,
    ]
  );

  return { ctx };
}
