export function agentRoute(agentId: string): string {
  return `/agents/${agentId}`;
}

export function agentChangesRoute(agentId: string): string {
  return `/agents/${agentId}/changes`;
}

export function agentChatRoute(agentId: string): string {
  return `/agents/${agentId}/chat`;
}

/** `?thread=<blockId>` on an agent route: the thread open in the drawer. */
export const THREAD_PARAM = "thread";
/** `?finding=<id>` with `thread`: the review finding to pick out. */
export const FINDING_PARAM = "finding";
/**
 * `?block=<blockId>` on an agent route: the block the page scrolls to and
 * marks, in the main column or (with `thread`) in the drawer's thread.
 */
export const BLOCK_PARAM = "block";

/**
 * A turn in the agent's own lineage opens on its page (including a child's
 * filtered view). A turn in another lineage opens on its owning stream.
 * Older snapshots without a stream id stay on the working agent's page.
 */
export function agentTurnLocation(
  agentId: string,
  turn: { blockId: string; threadId: string | null; streamId?: string },
  ownStreamId: string = agentId
): { pathname: string; search: string } {
  const params = new URLSearchParams();
  if (turn.threadId) params.set(THREAD_PARAM, turn.threadId);
  params.set(BLOCK_PARAM, turn.blockId);
  return {
    pathname: agentRoute(
      turn.streamId && turn.streamId !== ownStreamId ? turn.streamId : agentId
    ),
    search: `?${params.toString()}`,
  };
}
