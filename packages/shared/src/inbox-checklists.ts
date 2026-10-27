import type { Block } from "./block-types.js";

/** The same bound on initial reads, live updates and Inbox derivation. */
export const INBOX_CHECKLISTS_MAX = 12;

/** Match the agent view: quiet roots retain deliberately surfaced outcomes;
 * direct child pages show that child's own posts regardless of the toggle. */
export function isInboxChecklist(
  block: Block,
  rootId: string,
  childScope: boolean | string
): block is Extract<Block, { kind: "tasks" }> {
  if (
    block.streamId !== rootId ||
    block.kind !== "tasks" ||
    block.author.kind !== "agent"
  )
    return false;
  if (typeof childScope === "string")
    return block.author.agentId === childScope;
  if (childScope) return true;
  return (
    (block.threadId === null && block.toAgentId === null) ||
    (block.author.agentId === rootId &&
      (block.toAgentId === null || block.toAgentId === rootId))
  );
}
