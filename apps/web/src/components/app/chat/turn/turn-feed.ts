import type { StreamBlockEntry, StreamEntry } from "@dispatch/shared";

import type { TodoItem } from "./registry";

/** The newest turn in the feed (its block, turn attached), settled or not. */
export function newestTurnEntry(
  entries: readonly StreamEntry[]
): StreamBlockEntry | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.block.turn) return entry;
  }
  return null;
}

/** The plan of the newest turn that reported one; empty when none did. */
export function latestTurnPlan(entries: readonly StreamEntry[]): TodoItem[] {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const plan = entries[i]?.block.turn?.plan;
    if (plan === undefined) continue;
    return plan.map((e) => ({ content: e.content, status: e.status }));
  }
  return [];
}
