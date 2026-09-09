import type { ChatFeedEntry, ChatTurnEntry } from "@dispatch/shared";

import type { TodoItem } from "@/components/app/chat/turn/registry";

/**
 * What Enter and the arrows do right now, in the composer's helper line.
 *
 * On a touch keyboard neither ArrowUp nor Ctrl+C exists, and the full string
 * wraps to three lines under a narrow field, so only the Enter half is worth
 * saying there. The Stop button and the queued row's own Send now / Remove
 * cover the rest.
 */
export function composerHint(
  streaming: boolean,
  queuedCount: number,
  isMobile = false
): string | undefined {
  if (!streaming && queuedCount === 0) return undefined;
  const parts = [
    streaming
      ? "Agent is working · Enter queues your message"
      : "Message queued",
  ];
  if (isMobile) return parts[0];
  if (queuedCount > 0) parts.push("↑ edits the queued one");
  if (streaming) parts.push("Ctrl+C stops");
  return parts.join(" · ");
}

/**
 * `useChatFeed` hands over one ascending list across every page it holds
 * (`flattenFeedPages`), so one walk back from the end needs no page
 * bookkeeping. Rows created while the turn ran carry their own later
 * timestamps and sit after it, which is why this looks past the tail.
 */
export function newestTurnEntry(
  entries: readonly ChatFeedEntry[]
): ChatTurnEntry | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type === "turn") return entry;
  }
  return null;
}

/**
 * A running turn carries its plan the same way a settled one does, so
 * unlike the turns-endpoint version this needs no live/settled split.
 */
export function latestTurnPlan(entries: readonly ChatFeedEntry[]): TodoItem[] {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "turn" || entry.plan === undefined) continue;
    return entry.plan.map((e) => ({ content: e.content, status: e.status }));
  }
  return [];
}

/**
 * For the composer's ArrowUp history, so only prompts that came from the
 * composer: a launch post, a prompt from another agent and an injected one
 * were never typed here.
 */
export function harnessPromptHistory(
  entries: readonly ChatFeedEntry[]
): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "turn" || entry.prompt.source !== "chat") continue;
    const text = entry.prompt.text.trim();
    if (text && out[out.length - 1] !== text) out.push(text);
  }
  return out;
}
