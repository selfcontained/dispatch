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
 * Where an agent's running turn is: its own page (a child's page reads its
 * root's stream, filtered to it, so the child's turns are always there),
 * scrolled to the turn's block, with its thread open in the drawer when
 * the turn sits in one.
 */
export function agentTurnLocation(
  agentId: string,
  turn: { blockId: string; threadId: string | null }
): { pathname: string; search: string } {
  const params = new URLSearchParams();
  if (turn.threadId) params.set(THREAD_PARAM, turn.threadId);
  params.set(BLOCK_PARAM, turn.blockId);
  return { pathname: agentRoute(agentId), search: `?${params.toString()}` };
}
