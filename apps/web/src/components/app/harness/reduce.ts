// Ported from @mytraai/promptkit (MytraAI/mytra-os-uis, packages/promptkit) —
// Nii Yeboah's PromptKit design. Adapted to Dispatch's tokens and shadcn.
import type { Step, Trace } from "./contracts";
import type { StreamEvent } from "./contracts";

/**
 * Stable step id within a trace — `{kind}:{attempt ?? 0}`.
 *
 * @param kind - Host-namespaced step kind.
 * @param attempt - Generation attempt (1-indexed); omitted for one-shot steps.
 */
export function stepId(kind: string, attempt?: number): string {
  return `${kind}:${attempt ?? 0}`;
}

/**
 * Resolve the id the reducer keys a `step`/`step_update` event on: the
 * event's own {@link StreamEvent} `id` when present, else the derived
 * {@link stepId} fallback.
 *
 * @param event - A `step` or `step_update` stream event.
 */
function resolveStepId(
  event: Extract<StreamEvent, { type: "step" | "step_update" }>
): string {
  return event.id ?? stepId(event.kind, event.attempt);
}

/**
 * Start a fresh trace at turn kickoff.
 *
 * @remarks
 * Deterministic given an explicit `now`; the default argument reads the
 * wall clock (`Date.now()`), so a no-arg call is impure.
 *
 * @param now - Epoch ms; defaults to `Date.now()`.
 */
export function newTrace(now: number = Date.now()): Trace {
  return { startedAt: now, steps: [] };
}

/**
 * Fold one {@link StreamEvent} into a trace. Immutable — safe inside any
 * state setter or reducer. Events other than `step` / `step_update` return
 * the trace unchanged (same reference).
 *
 * @remarks
 * Pure and deterministic GIVEN an explicit `now`; the default argument
 * reads the wall clock (`Date.now()`), so a no-arg call is impure.
 *
 * Semantics ported from Brane's `generation-trace.ts`, generalized with an
 * explicit step id (see `resolveStepId`):
 * - Each `step`/`step_update` is keyed on its explicit `id` when present,
 *   else on the derived {@link stepId}. Replayed `step` events (same
 *   resolved id, e.g. on reconnect) are ignored.
 * - A `step_update` without a prior `step` synthesizes the step so data is
 *   never dropped, backdating `startedAt` by `durMs` when provided.
 * - On a `step_update` landing on an existing step, `reason` and `detail`
 *   are LAST-WRITER-WINS: the incoming event's values are used even when
 *   absent (clearing a stale value from an earlier update). `durMs` stays
 *   sticky: `event.durMs ?? prior.durMs`.
 *
 * @param trace - The trace so far.
 * @param event - The incoming stream event.
 * @param now - Epoch ms; defaults to `Date.now()`.
 */
export function applyStreamEvent(
  trace: Trace,
  event: StreamEvent,
  now: number = Date.now()
): Trace {
  if (event.type === "step") {
    const id = resolveStepId(event);
    if (trace.steps.some((s) => s.id === id)) return trace;
    const step: Step = {
      id,
      kind: event.kind,
      label: event.label,
      attempt: event.attempt,
      status: "running",
      startedAt: now,
    };
    return { ...trace, steps: [...trace.steps, step] };
  }

  if (event.type === "step_update") {
    const id = resolveStepId(event);
    const idx = trace.steps.findIndex((s) => s.id === id);
    if (idx < 0) {
      const step: Step = {
        id,
        kind: event.kind,
        attempt: event.attempt,
        status: event.status,
        startedAt: event.durMs ? now - event.durMs : now,
        endedAt: now,
        durMs: event.durMs,
        reason: event.reason,
        detail: event.detail,
      };
      return { ...trace, steps: [...trace.steps, step] };
    }
    const steps = trace.steps.slice();
    const prior = steps[idx];
    steps[idx] = {
      ...prior,
      status: event.status,
      endedAt: now,
      durMs: event.durMs ?? prior.durMs,
      reason: event.reason,
      detail: event.detail,
    };
    return { ...trace, steps };
  }

  return trace;
}

/**
 * Mark the trace as finished.
 *
 * @remarks
 * Deterministic given an explicit `now`; the default argument reads the
 * wall clock (`Date.now()`), so a no-arg call is impure.
 *
 * @param trace - The trace to finish.
 * @param outcome - Terminal outcome of the turn's work.
 * @param now - Epoch ms; defaults to `Date.now()`.
 */
export function finishTrace(
  trace: Trace,
  outcome: "ok" | "error" | "clarification",
  now: number = Date.now()
): Trace {
  return { ...trace, endedAt: now, finalResult: outcome };
}

/**
 * Gap (ms) between the trace's wall-clock duration and the sum of recorded
 * step durations. Values at or below 250 ms — and negative deltas from
 * overlapping server-side timers — return 0. Used to render an
 * "unaccounted time" row so slow unlabeled phases stay visible.
 *
 * @param trace - A finished trace (running traces return 0).
 */
export function computeUnaccountedMs(trace: Trace): number {
  if (!trace.endedAt) return 0;
  const total = trace.endedAt - trace.startedAt;
  let summed = 0;
  for (const step of trace.steps) {
    if (typeof step.durMs === "number") summed += step.durMs;
  }
  const delta = total - summed;
  return delta > 250 ? delta : 0;
}

/** Default retention cap for {@link pruneTraces}. */
export const DEFAULT_MAX_TRACES = 20;

/**
 * Apply a trace retention cap to a conversation. Once more than `max` turns
 * carry a trace, the OLDEST excess turns lose their `trace` field; turn
 * content, ordering, and every other field are preserved. Returns the input
 * array unchanged (same reference) when under the cap.
 *
 * @param turns - Conversation turns, oldest first.
 * @param max - Retention cap; defaults to {@link DEFAULT_MAX_TRACES}.
 */
export function pruneTraces<
  T extends {
    /** The turn's trace, if any. */
    trace?: Trace;
  },
>(turns: T[], max: number = DEFAULT_MAX_TRACES): T[] {
  const traceIndexes: number[] = [];
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].trace) traceIndexes.push(i);
  }
  if (traceIndexes.length <= max) return turns;

  const dropSet = new Set(traceIndexes.slice(0, traceIndexes.length - max));
  return turns.map((turn, i) => {
    if (!dropSet.has(i)) return turn;
    const { trace: _trace, ...rest } = turn;
    return rest as T;
  });
}
