import { describe, expect, it } from "vitest";
import {
  budgetProfileHash,
  evaluateBudget,
} from "../src/agents/context-transfer/budget.js";
import { now, transferFixture } from "./helpers/context-transfer-fixture.js";

function evaluate(request = transferFixture()) {
  request.budget.identity.budgetProfileHash = budgetProfileHash(request.budget);
  return evaluateBudget(
    request.budget,
    { identity: request.handoff.identity, boundary: 7 },
    now
  );
}
describe("context transfer budget contract", () => {
  it.each([
    [24575, "continue"],
    [24576, "continue"],
    [24577, "prepare"],
  ])("accounts for all reserves once at %i", (count, action) => {
    const r = transferFixture();
    r.budget.renderedInputTokens = count as number;
    expect(evaluate(r)).toEqual({ action, inputCeiling: 24576 });
  });
  it("compacts before preparing and continues when compaction restores room", () => {
    const r = transferFixture();
    r.budget.phase = "before-compaction";
    expect(evaluate(r).action).toBe("compact");
    r.budget.phase = "after-compaction";
    r.budget.renderedInputTokens = 24000;
    expect(evaluate(r).action).toBe("continue");
  });
  it("treats the input cap independently of output reserve", () => {
    const r = transferFixture();
    r.budget.inputLimitTokens = 28000;
    expect(evaluate(r)).toEqual({ action: "prepare", inputCeiling: 24576 });
    r.budget.inputLimitTokens = 20000;
    expect(evaluate(r)).toEqual({ action: "prepare", inputCeiling: 20000 });
  });
  it("does not add cached input twice", () => {
    const r = transferFixture();
    r.budget.renderedInputTokens = 24576;
    r.budget.cachedInputTokens = 24576;
    expect(evaluate(r).action).toBe("continue");
    r.budget.cachedInputTokens++;
    expect(evaluate(r)).toEqual({
      action: "blocked",
      reason: "invalid_cache_subset",
    });
  });
  it.each(["system", "schemas", "history", "tools", "images"] as const)(
    "blocks when %s accounting is missing",
    (key) => {
      const r = transferFixture();
      r.budget.counted[key] = false;
      expect(evaluate(r).action).toBe("blocked");
    }
  );
  it("rejects unknown, stale, future, malformed and version-mismatched observations", () => {
    const r = transferFixture();
    r.budget.source = "unknown";
    expect(evaluate(r).action).toBe("blocked");
    r.budget.source = "exact-render";
    const expected = { identity: r.handoff.identity, boundary: 7 };
    for (const time of [now - 1, now + 30001, NaN])
      expect(evaluateBudget(r.budget, expected, time).action).toBe("blocked");
    for (const bad of [
      { ...r.budget, version: 2 },
      { ...r.budget, outputTokens: -1 },
      { ...r.budget, renderedInputTokens: null },
    ]) {
      expect(evaluateBudget(bad, expected, now).action).toBe("blocked");
    }
    expect(evaluateBudget(r.budget, expected, now, NaN).action).toBe("blocked");
  });
  it.each([
    "cwd",
    "branch",
    "head",
    "dirtyHash",
    "permissionsHash",
    "sessionId",
    "modelId",
    "budgetProfileHash",
  ] as const)("rejects changed %s", (key) => {
    const r = transferFixture();
    const expected = structuredClone(r.handoff.identity);
    expected[key] = key.endsWith("Hash")
      ? "9".repeat(64)
      : key === "head"
        ? "9".repeat(40)
        : "/changed";
    expect(
      evaluateBudget(r.budget, { identity: expected, boundary: 7 }, now).action
    ).toBe("blocked");
  });
  it("rejects a tokenizer, template or limit drift without a matching runtime profile", () => {
    for (const key of ["tokenizerHash", "templateHash"] as const) {
      const r = transferFixture();
      r.budget[key] = "9".repeat(64);
      expect(
        evaluateBudget(
          r.budget,
          { identity: r.handoff.identity, boundary: 7 },
          now
        )
      ).toEqual({ action: "blocked", reason: "profile_mismatch" });
    }
    const r = transferFixture();
    r.budget.contextTokens++;
    expect(
      evaluateBudget(
        r.budget,
        { identity: r.handoff.identity, boundary: 7 },
        now
      ).action
    ).toBe("blocked");
  });
  it("rejects exhausted reserves and a different boundary", () => {
    const r = transferFixture();
    r.budget.outputTokens = 32768;
    expect(evaluate(r).action).toBe("blocked");
    expect(
      evaluateBudget(
        transferFixture().budget,
        { identity: r.handoff.identity, boundary: 8 },
        now
      ).action
    ).toBe("blocked");
  });
});
