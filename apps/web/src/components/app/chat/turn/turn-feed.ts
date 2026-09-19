import type { StreamEntry, ChatTurnEntry } from "@dispatch/shared";

import type { TodoItem } from "./registry";

/** The newest turn in the feed, whether or not it has settled. */
export function newestTurnEntry(
  entries: readonly StreamEntry[]
): ChatTurnEntry | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type === "turn") return entry;
  }
  return null;
}

/** The plan of the newest turn that reported one; empty when none did. */
export function latestTurnPlan(entries: readonly StreamEntry[]): TodoItem[] {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "turn" || entry.plan === undefined) continue;
    return entry.plan.map((e) => ({ content: e.content, status: e.status }));
  }
  return [];
}
