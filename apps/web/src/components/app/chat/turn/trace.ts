/**
 * A turn feed row as the rail's model: kept apart from the views so code
 * outside the column (the sidebar's turn label) can read a turn without
 * loading them.
 */
import type {
  Block,
  ChatTurnEntry,
  ChatTurnStep,
  StreamBlockEntry,
  StreamEntry,
} from "@dispatch/shared";

import type { Step, Trace } from "./contracts";

/** A feed row that is a turn: the agent's answer block with its turn attached. */
export function isTurnEntry(
  entry: StreamEntry
): entry is StreamBlockEntry & { block: Block & { turn: ChatTurnEntry } } {
  return entry.type === "block" && entry.block.turn !== undefined;
}

/** One trace step as the rail's model carries it: ISO times become epoch ms. */
export function turnStep(step: ChatTurnStep): Step {
  return {
    id: step.id,
    kind: step.kind,
    label: step.label,
    status: step.status,
    startedAt: Date.parse(step.startedAt),
    ...(step.endedAt ? { endedAt: Date.parse(step.endedAt) } : {}),
    ...(step.durMs !== undefined ? { durMs: step.durMs } : {}),
    detail: step.detail,
    ...(step.children?.length ? { children: step.children.map(turnStep) } : {}),
  };
}

export function turnTrace(turn: ChatTurnEntry): Trace {
  return {
    startedAt: Date.parse(turn.trace.startedAt),
    ...(turn.trace.endedAt ? { endedAt: Date.parse(turn.trace.endedAt) } : {}),
    ...(turn.trace.finalResult ? { finalResult: turn.trace.finalResult } : {}),
    steps: turn.trace.steps.map(turnStep),
  };
}
