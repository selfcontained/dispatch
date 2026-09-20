/**
 * Another agent's turn as a drawer page: the turn in full, as it reads on
 * that agent's own page — its prompt, its steps, its answer. The stream
 * folds a child's turns to one row each; this is where one opens.
 */
import { useCallback, useMemo } from "react";
import type { ChatTurnEntry } from "@dispatch/shared";
import { useQuery } from "@tanstack/react-query";

import { TurnEntryView } from "@/components/app/chat/turn/turn-entry-view";
import { useChatFeedContext } from "@/components/app/chat/use-chat-feed-context";
import { type Agent } from "@/components/app/types";
import { fetchAgents } from "@/hooks/use-agent-tree";
import { useStreamFeedCache } from "@/hooks/use-stream";

export type TurnPageProps = {
  rootId: string;
  turnId: string;
  openLightbox: (fileId: number) => void;
  onOpenPath?: (path: string, line: number | null) => void;
  onOpenThread: (blockId: string, findingId?: string) => void;
};

/** The turn in the feed cache with this id, or null while it is not loaded. */
export function useTurnEntry(
  rootId: string | null,
  turnId: string | null
): ChatTurnEntry | null {
  const entries = useStreamFeedCache(rootId);
  return useMemo(
    () =>
      (entries.find((entry) => entry.type === "turn" && entry.id === turnId) as
        | ChatTurnEntry
        | undefined) ?? null,
    [entries, turnId]
  );
}

export function TurnPage({
  rootId,
  turnId,
  openLightbox,
  onOpenPath,
  onOpenThread,
}: TurnPageProps): JSX.Element {
  const entry = useTurnEntry(rootId, turnId);
  const agentId = entry?.agentId ?? null;
  const select = useCallback(
    (agents: Agent[]) => agents.find((agent) => agent.id === agentId) ?? null,
    [agentId]
  );
  const { data: agent } = useQuery<Agent[], Error, Agent | null>({
    queryKey: ["agents"],
    queryFn: fetchAgents,
    select,
    enabled: agentId !== null,
  });
  // The page reads as the turn's own agent, so the turn renders in full
  // (as on that agent's page) rather than folded to a child's row.
  const { ctx } = useChatFeedContext({
    agentId,
    rootId,
    agent: agent ?? null,
    openLightbox,
    onOpenPath,
    onOpenThread,
  });
  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-2"
      data-testid="drawer-turn-page"
      data-turn-id={turnId}
    >
      {entry ? (
        <TurnEntryView entry={entry} grouped={false} ctx={ctx} />
      ) : (
        <div className="px-4 py-6 text-center text-xs text-muted-foreground">
          This turn is not in the loaded part of the stream.
        </div>
      )}
    </div>
  );
}
