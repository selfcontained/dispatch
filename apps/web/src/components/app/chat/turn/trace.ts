// Ported from @mytraai/promptkit (MytraAI/mytra-os-uis, packages/promptkit):
// Nii Yeboah's PromptKit design. Adapted to Dispatch's tokens and shadcn.
import type { Trace } from "./contracts";

/**
 * Gap (ms) between the trace's wall-clock duration and the sum of recorded
 * step durations, so a slow unlabeled phase shows as an "unaccounted time"
 * row. Gaps at or below 250ms, and negative ones from overlapping
 * server-side timers, return 0; so does a trace still running.
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
