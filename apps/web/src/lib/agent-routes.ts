export function agentRoute(agentId: string): string {
  return `/agents/${agentId}`;
}

export function agentChangesRoute(agentId: string): string {
  return `/agents/${agentId}/changes`;
}

export function agentChatRoute(agentId: string): string {
  return `/agents/${agentId}/chat`;
}

/** `?thread=<blockId>` on an agent route: the thread open in the side panel. */
export const THREAD_PARAM = "thread";
/** `?finding=<id>` with `thread`: the review finding to pick out. */
export const FINDING_PARAM = "finding";
