import type { BackgroundUpdate } from "./background-ingress.js";

export type BackgroundEvent = {
  type: "background";
  agentId: string;
  generation: string;
  sessionId: string;
  provider: "claude" | "codex";
  at: string;
  sequence: number;
} & (
  | { kind: "capability"; supported: boolean }
  | { kind: "update"; update: BackgroundUpdate }
);
import type { BackgroundItem, BackgroundSnapshot } from "@dispatch/shared";
export type { BackgroundItem, BackgroundSnapshot } from "@dispatch/shared";
export const emptyBackground = (): BackgroundSnapshot => ({
  capability: "unknown",
  stale: false,
  items: [],
});
const terminal = (state: BackgroundItem["state"]) =>
  state === "completed" || state === "failed" || state === "stopped";

/** Bounded materialized view; source journal remains the replay authority. */
export function projectBackground(
  previous: BackgroundSnapshot,
  event: BackgroundEvent
): BackgroundSnapshot {
  if (event.kind === "capability") {
    if (
      previous.generation === event.generation ||
      (previous.generationStartedAt && previous.generationStartedAt >= event.at)
    )
      return previous;
    return {
      generation: event.generation,
      generationStartedAt: event.at,
      lastSequence: event.sequence,
      capability: event.supported ? "supported" : "unsupported",
      stale: false,
      items: previous.items.map((item) => ({ ...item, stale: true })),
    };
  }
  // Replayed updates from a replaced connection must not establish a new generation.
  if (
    previous.generation !== event.generation ||
    previous.capability !== "supported" ||
    event.sequence <= (previous.lastSequence ?? 0)
  )
    return previous;
  const update = event.update;
  const index = previous.items.findIndex(
    (item) =>
      item.generation === event.generation && item.id === update.asyncTaskId
  );
  const old = previous.items[index];
  if (old && old.sequence >= event.sequence) return previous;
  const item: BackgroundItem = {
    ...(old ?? {
      id: update.asyncTaskId,
      generation: event.generation,
      sessionId: event.sessionId,
      provider: event.provider,
    }),
    source: "acp-asyncTasks",
    lastObservation: event.at,
    sequence: event.sequence,
    stale: previous.stale,
    ...(update.toolCallId ? { toolCallId: update.toolCallId } : {}),
  };
  if (update.sessionUpdate === "async_task_spawned") {
    item.canStop = update.canStop;
    item.showInTranscript = update.showInTranscript;
    item.name = update.name;
    item.taskType = update.taskType;
    item.description = update.description ?? item.description;
    // Late spawn never resurrects a terminal task.
    item.state ??= "running";
  } else if (update.sessionUpdate === "async_task_state_update") {
    // Terminal corrections (e.g. best-effort stopped → completed) remain authoritative.
    if (!terminal(item.state) || terminal(update.state))
      item.state = update.state;
    item.summary = update.summary ?? item.summary;
  } else {
    item.description = update.description ?? item.description;
    item.summary = update.summary ?? item.summary;
  }
  const items = previous.items.filter((_, i) => i !== index);
  items.push(item);
  // Retain at most 200 observations, preferring current nonterminal items.
  items.sort(
    (a, b) =>
      Number(b.generation === event.generation && !terminal(b.state)) -
        Number(a.generation === event.generation && !terminal(a.state)) ||
      b.lastObservation.localeCompare(a.lastObservation)
  );
  return {
    ...previous,
    lastSequence: event.sequence,
    items: items.slice(0, 200),
    ...(items.length > 200 || previous.truncated ? { truncated: true } : {}),
  };
}
