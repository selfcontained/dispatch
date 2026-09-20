import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  type FeedContext,
  type PeerDirectory,
  peerDirectory,
} from "@/components/app/chat/chat-entries";
import { type Agent } from "@/components/app/types";
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
}: ChatFeedContextInput): ChatFeedContextResult {
  // The sidebar's agent list, read for a peer post's icon and lineage.
  // `select` narrows it to what the feed shows, so structural sharing keeps
  // the directory's identity across agent updates that change nothing here;
  // a stable selector lets react-query skip re-running it at all.
  const selectPeers = useCallback(
    (agents: Agent[]) => peerDirectory(agentId ?? "", agents),
    [agentId]
  );
  const { data: peers } = useQuery<Agent[], Error, PeerDirectory>({
    queryKey: ["agents"],
    queryFn: async () => {
      const payload = await api<{ agents: Agent[] }>("/api/v1/agents");
      return payload.agents;
    },
    select: selectPeers,
  });

  const agentName = agent?.name;
  const agentType = agent?.type ?? null;
  const agentModel = agent?.model ?? null;
  const ctx = useMemo<FeedContext>(
    () => ({
      agentId: agentId ?? "",
      rootId,
      agentName,
      agentType,
      agentModel,
      peers,
      onOpenFile: openLightbox,
      onOpenPath,
      onToggleReaction,
      onOpenThread,
      onSubmitForm,
      onSetBlockState,
    }),
    [
      agentId,
      rootId,
      agentName,
      agentType,
      onOpenPath,
      onToggleReaction,
      onOpenThread,
      onSubmitForm,
      onSetBlockState,
      openLightbox,
      peers,
    ]
  );

  return { ctx };
}
