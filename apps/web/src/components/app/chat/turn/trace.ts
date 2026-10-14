/**
 * A turn feed row as the step list's model: kept apart from the views so code
 * outside the column (the sidebar's turn label) can read a turn without
 * loading them.
 */
import type {
  Block,
  BlockStartup,
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

/**
 * Converted steps by their source object. The feed cache shares every step
 * that did not change between two versions of a turn, so a step keeps its
 * identity across stream updates and only the rows whose step moved render.
 */
const convertedSteps = new WeakMap<ChatTurnStep, Step>();

/** One trace step as the step list's model carries it: ISO times become epoch ms. */
export function turnStep(step: ChatTurnStep): Step {
  const known = convertedSteps.get(step);
  if (known) return known;
  const converted: Step = {
    id: step.id,
    kind: step.kind,
    label: step.label,
    status: step.status,
    startedAt: Date.parse(step.startedAt),
    ...(step.updatedAt ? { updatedAt: Date.parse(step.updatedAt) } : {}),
    ...(step.endedAt ? { endedAt: Date.parse(step.endedAt) } : {}),
    ...(step.durMs !== undefined ? { durMs: step.durMs } : {}),
    detail: step.detail,
    ...(step.children?.length ? { children: step.children.map(turnStep) } : {}),
  };
  convertedSteps.set(step, converted);
  return converted;
}

export function turnTrace(turn: ChatTurnEntry): Trace {
  return {
    startedAt: Date.parse(turn.trace.startedAt),
    ...(turn.trace.lastProgressAt
      ? { lastProgressAt: Date.parse(turn.trace.lastProgressAt) }
      : {}),
    ...(turn.trace.endedAt ? { endedAt: Date.parse(turn.trace.endedAt) } : {}),
    ...(turn.trace.finalResult ? { finalResult: turn.trace.finalResult } : {}),
    steps: turn.trace.steps.map(turnStep),
  };
}

/** Launch preparation uses the same trace model and renderer as agent activity. */
export function startupTrace(startup: BlockStartup | undefined): Trace {
  const steps = startup?.steps ?? [];
  const at = (iso: string | undefined): number | undefined => {
    if (!iso) return undefined;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : undefined;
  };
  const first = at(steps[0]?.startedAt) ?? Date.now();
  const last = steps.reduce(
    (latest, step) => Math.max(latest, at(step.endedAt) ?? 0),
    0
  );
  const ended =
    startup?.failed || startup?.readyAt
      ? (at(startup.readyAt) ?? (last || first))
      : undefined;
  return {
    startedAt: first,
    ...(ended !== undefined ? { endedAt: ended } : {}),
    ...(startup?.failed ? { finalResult: "error" as const } : {}),
    steps: steps.map((step) => {
      const startedAt = at(step.startedAt) ?? first;
      const endedAt = at(step.endedAt);
      // A path keeps its end, where the directory's own name is; a reason
      // keeps its start.
      const path =
        !step.detail && step.phase === "worktree" ? startup?.cwd : undefined;
      const aside = step.detail ?? path;
      return {
        id: step.phase,
        kind: "setup",
        label: step.label,
        status:
          step.status === "failed"
            ? ("error" as const)
            : step.status === "done"
              ? ("ok" as const)
              : ("running" as const),
        startedAt,
        ...(endedAt !== undefined
          ? { endedAt, durMs: Math.max(0, endedAt - startedAt) }
          : {}),
        ...(aside
          ? {
              detail: {
                text: aside,
                ...(path ? { clipStart: true } : {}),
                ...(step.status === "failed" && step.detail
                  ? { terminalOutput: step.detail }
                  : {}),
              },
            }
          : {}),
      };
    }),
  };
}
