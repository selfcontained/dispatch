import type { StreamEntry } from "@dispatch/shared";

import { turnAnswerText } from "./answer-text";
import { foldAttachments, type FoldedEntry } from "./turn-attachments";

/** Hide only a proven successful no-op; missing historical data stays visible. */
export function isEmptySuccessfulTurn(
  entry: StreamEntry,
  folded: readonly FoldedEntry[] | undefined
): boolean {
  const { block } = entry;
  const turn = block.turn;
  if (
    !turn ||
    turn.settled !== true ||
    turn.interrupted !== false ||
    turn.trace?.finalResult !== "ok" ||
    !Array.isArray(turn.trace.steps) ||
    turn.trace.steps.length > 0 ||
    turn.trace.detailsOmitted ||
    turn.result?.streaming ||
    turn.result?.truncated ||
    turn.error !== undefined ||
    turn.errorKind !== undefined ||
    turn.retry !== undefined ||
    turn.plan?.length ||
    turn.questions?.length
  ) {
    return false;
  }
  // A turn can carry a normal block's content and conversation controls too.
  // Keep unresolved or unfamiliar block shapes rather than losing their access.
  if (
    block.kind !== "text" ||
    // Text blocks have no state; retain unexpected historical/actionable shapes.
    block.state !== null ||
    block.author.kind !== "agent" ||
    block.toAgentId !== null ||
    block.sharedMessage ||
    !Array.isArray(block.attachments) ||
    block.attachments.length > 0 ||
    block.blocks?.length ||
    block.inputReply ||
    block.replyCount ||
    block.unreadReplies ||
    block.lastReplyAt ||
    block.repliers?.length ||
    block.reactions?.length ||
    block.delivery?.length ||
    block.data?.responseTo?.length ||
    block.data?.scheduledMessageId ||
    block.data?.scheduledMessage ||
    folded?.length
  ) {
    return false;
  }
  // Match TurnAnswer and the copy action: assembled result text wins even
  // when empty; the persisted block snapshot is only a fallback.
  const answer = turnAnswerText(block, turn);
  return typeof answer === "string" && answer.trim().length === 0;
}

/**
 * Determine ownership before hiding no-ops. Return the original unfolded rows:
 * the renderer still needs them to fold attachments under their owning turns.
 * The pane uses the same projection for arrivals, landing and scroll targets.
 */
export function visibleFeedEntries(
  entries: StreamEntry[],
  agentId?: string
): StreamEntry[] {
  const fold = foldAttachments(entries, agentId);
  const hidden = new Set(
    fold.entries
      .filter((entry) =>
        isEmptySuccessfulTurn(entry, fold.folded.get(entry.id))
      )
      .map((entry) => entry.id)
  );
  return hidden.size > 0
    ? entries.filter((entry) => !hidden.has(entry.id))
    : entries;
}
