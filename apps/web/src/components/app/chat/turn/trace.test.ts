// Ported from @mytraai/promptkit (MytraAI/mytra-os-uis, packages/promptkit):
// Nii Yeboah's PromptKit design. Adapted to Dispatch's tokens and shadcn.
import { describe, expect, it } from "vitest";

import type { Trace } from "./contracts";
import { computeUnaccountedMs } from "./trace";

const T0 = 1_000_000;

describe("computeUnaccountedMs", () => {
  const finished = (steps: Trace["steps"], totalMs: number): Trace => ({
    startedAt: T0,
    endedAt: T0 + totalMs,
    steps,
  });
  const step = (durMs: number): Trace["steps"][number] => ({
    id: `k:${durMs}`,
    kind: "k",
    status: "ok",
    startedAt: T0,
    durMs,
  });

  it("returns 0 while the trace is still running", () => {
    expect(computeUnaccountedMs({ startedAt: T0, steps: [] })).toBe(0);
  });
  it("returns the gap when it exceeds 250ms", () => {
    expect(computeUnaccountedMs(finished([step(100), step(100)], 1000))).toBe(
      800
    );
  });
  it("returns 0 for gaps at or below the 250ms threshold", () => {
    expect(computeUnaccountedMs(finished([step(400), step(400)], 1000))).toBe(
      0
    );
  });
  it("clamps negative deltas (overlapping server timers) to 0", () => {
    expect(computeUnaccountedMs(finished([step(800), step(800)], 1000))).toBe(
      0
    );
  });
});
