// Ported from @mytraai/promptkit (MytraAI/mytra-os-uis, packages/promptkit) —
// Nii Yeboah's PromptKit design. Adapted to Dispatch's tokens and shadcn.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_TRACES,
  applyStreamEvent,
  computeUnaccountedMs,
  finishTrace,
  newTrace,
  pruneTraces,
  stepId,
} from "./reduce";
import type { Trace } from "./contracts";

const T0 = 1_000_000;

describe("stepId", () => {
  it("defaults attempt to 0", () => {
    expect(stepId("oracle.probe")).toBe("oracle.probe:0");
    expect(stepId("generate", 2)).toBe("generate:2");
  });
});

describe("applyStreamEvent — step", () => {
  it("appends a running step", () => {
    const trace = applyStreamEvent(
      newTrace(T0),
      { type: "step", kind: "oracle.probe", label: "Probing" },
      T0 + 5
    );
    expect(trace.steps).toEqual([
      {
        id: "oracle.probe:0",
        kind: "oracle.probe",
        label: "Probing",
        attempt: undefined,
        status: "running",
        startedAt: T0 + 5,
      },
    ]);
  });

  it("ignores a replayed step with the same id (reconnect replay)", () => {
    const trace = applyStreamEvent(
      newTrace(T0),
      { type: "step", kind: "generate", attempt: 1 },
      T0 + 5
    );
    const replayed = applyStreamEvent(
      trace,
      { type: "step", kind: "generate", attempt: 1 },
      T0 + 50
    );
    expect(replayed).toBe(trace); // unchanged reference — no-op
  });
});

describe("applyStreamEvent — step_update", () => {
  it("completes a running step with duration and detail", () => {
    let trace = applyStreamEvent(
      newTrace(T0),
      { type: "step", kind: "generate", attempt: 1 },
      T0 + 5
    );
    trace = applyStreamEvent(
      trace,
      {
        type: "step_update",
        kind: "generate",
        attempt: 1,
        status: "ok",
        durMs: 120,
        detail: { model: "x" },
      },
      T0 + 130
    );
    expect(trace.steps[0]).toMatchObject({
      status: "ok",
      endedAt: T0 + 130,
      durMs: 120,
      detail: { model: "x" },
    });
  });

  it("synthesizes a step when the update arrives without a prior start, backdating by durMs", () => {
    const trace = applyStreamEvent(
      newTrace(T0),
      {
        type: "step_update",
        kind: "palette.render-clip",
        status: "ok",
        durMs: 300,
      },
      T0 + 400
    );
    expect(trace.steps[0]).toMatchObject({
      id: "palette.render-clip:0",
      status: "ok",
      startedAt: T0 + 100, // backdated: now - durMs
      endedAt: T0 + 400,
    });
  });

  it("marks retry and error statuses with reasons", () => {
    let trace = applyStreamEvent(
      newTrace(T0),
      { type: "step", kind: "generate", attempt: 1 },
      T0
    );
    trace = applyStreamEvent(
      trace,
      {
        type: "step_update",
        kind: "generate",
        attempt: 1,
        status: "retry",
        reason: "validator failed",
      },
      T0 + 90
    );
    expect(trace.steps[0]).toMatchObject({
      status: "retry",
      reason: "validator failed",
      endedAt: T0 + 90,
    });

    trace = applyStreamEvent(
      trace,
      { type: "step", kind: "generate", attempt: 2 },
      T0 + 100
    );
    trace = applyStreamEvent(
      trace,
      {
        type: "step_update",
        kind: "generate",
        attempt: 2,
        status: "error",
        reason: "timed out",
      },
      T0 + 500
    );
    expect(trace.steps[1]).toMatchObject({
      id: "generate:2",
      status: "error",
      reason: "timed out",
    });
  });
});

describe("applyStreamEvent — explicit step id", () => {
  it("keeps two steps with the same kind+attempt distinct when they carry different explicit ids", () => {
    let trace = applyStreamEvent(
      newTrace(T0),
      { type: "step", kind: "palette.render-clip", id: "clip-1" },
      T0 + 1
    );
    trace = applyStreamEvent(
      trace,
      { type: "step", kind: "palette.render-clip", id: "clip-2" },
      T0 + 2
    );
    trace = applyStreamEvent(
      trace,
      { type: "step", kind: "palette.render-clip", id: "clip-3" },
      T0 + 3
    );
    expect(trace.steps.length).toBe(3);
    expect(trace.steps.map((s) => s.id)).toEqual([
      "clip-1",
      "clip-2",
      "clip-3",
    ]);
  });

  it("a step_update with an explicit id updates the matching step, not the first-by-kind", () => {
    let trace = applyStreamEvent(
      newTrace(T0),
      { type: "step", kind: "palette.render-clip", id: "clip-1" },
      T0 + 1
    );
    trace = applyStreamEvent(
      trace,
      { type: "step", kind: "palette.render-clip", id: "clip-2" },
      T0 + 2
    );
    trace = applyStreamEvent(
      trace,
      {
        type: "step_update",
        kind: "palette.render-clip",
        id: "clip-2",
        status: "ok",
        durMs: 10,
      },
      T0 + 12
    );
    expect(trace.steps[0]).toMatchObject({ id: "clip-1", status: "running" });
    expect(trace.steps[1]).toMatchObject({
      id: "clip-2",
      status: "ok",
      durMs: 10,
    });
  });

  it("replay dedup still holds for the same explicit id (same trace reference)", () => {
    const trace = applyStreamEvent(
      newTrace(T0),
      { type: "step", kind: "generate", id: "g-1", attempt: 1 },
      T0 + 5
    );
    const replayed = applyStreamEvent(
      trace,
      { type: "step", kind: "generate", id: "g-1", attempt: 1 },
      T0 + 50
    );
    expect(replayed).toBe(trace);
  });
});

describe("applyStreamEvent — last-writer-wins for reason/detail", () => {
  it("clears a stale reason when a later step_update on the same id omits it", () => {
    let trace = applyStreamEvent(
      newTrace(T0),
      { type: "step", kind: "generate", id: "g-1" },
      T0
    );
    trace = applyStreamEvent(
      trace,
      {
        type: "step_update",
        kind: "generate",
        id: "g-1",
        status: "retry",
        reason: "x",
      },
      T0 + 10
    );
    expect(trace.steps[0]).toMatchObject({ status: "retry", reason: "x" });

    trace = applyStreamEvent(
      trace,
      { type: "step_update", kind: "generate", id: "g-1", status: "ok" },
      T0 + 20
    );
    expect(trace.steps[0].status).toBe("ok");
    expect(trace.steps[0].reason).toBeUndefined();
  });
});

describe("applyStreamEvent — non-step events", () => {
  it("leaves the trace unchanged for delta/result/artifact/tool_call/error/done", () => {
    const trace = newTrace(T0);
    for (const event of [
      { type: "delta", text: "hi" },
      { type: "result", content: "done" },
      { type: "tool_call", call: { tool: "t", args: {} } },
      { type: "error", error: { code: "boom", message: "boom" } },
      { type: "done" },
    ] as const) {
      expect(applyStreamEvent(trace, event, T0 + 1)).toBe(trace);
    }
  });
});

describe("finishTrace", () => {
  it("stamps endedAt and finalResult", () => {
    const trace = finishTrace(newTrace(T0), "clarification", T0 + 900);
    expect(trace).toMatchObject({
      endedAt: T0 + 900,
      finalResult: "clarification",
    });
  });
});

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
    expect(computeUnaccountedMs(newTrace(T0))).toBe(0);
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

describe("pruneTraces", () => {
  const turnWithTrace = (id: string): { id: string; trace?: Trace } => ({
    id,
    trace: { startedAt: T0, steps: [] },
  });

  it("is a no-op at or under the cap", () => {
    const turns = [turnWithTrace("a"), turnWithTrace("b")];
    expect(pruneTraces(turns, 2)).toBe(turns);
  });

  it("drops traces from the OLDEST turns beyond the cap, preserving all other fields and order", () => {
    const turns = [
      turnWithTrace("a"),
      { id: "no-trace" },
      turnWithTrace("b"),
      turnWithTrace("c"),
    ];
    const pruned = pruneTraces(turns, 2);
    expect(pruned.map((t) => t.id)).toEqual(["a", "no-trace", "b", "c"]);
    expect(pruned[0].trace).toBeUndefined(); // oldest trace dropped
    expect(pruned[2].trace).toBeDefined();
    expect(pruned[3].trace).toBeDefined();
  });

  it("defaults the cap to DEFAULT_MAX_TRACES", () => {
    const turns = Array.from({ length: DEFAULT_MAX_TRACES + 1 }, (_, i) =>
      turnWithTrace(String(i))
    );
    const pruned = pruneTraces(turns);
    expect(pruned[0].trace).toBeUndefined();
    expect(pruned[1].trace).toBeDefined();
  });
});
