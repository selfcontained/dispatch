import { describe, expect, it } from "vitest";
import {
  isLegalTransition,
  isTerminalPhase,
  type AssistedPhase,
} from "../src/assisted-update-store.js";

describe("assisted-update-store transitions", () => {
  it("allows the canonical forward sequence", () => {
    const seq: AssistedPhase[] = [
      "inspect",
      "prepare",
      "apply",
      "restarting",
      "validate",
      "done",
    ];
    for (let i = 0; i < seq.length - 1; i++) {
      expect(isLegalTransition(seq[i]!, seq[i + 1]!)).toBe(true);
    }
  });

  it("allows skipping forward phases", () => {
    expect(isLegalTransition("inspect", "apply")).toBe(true);
    expect(isLegalTransition("prepare", "validate")).toBe(true);
  });

  it("disallows moving backward through forward phases", () => {
    expect(isLegalTransition("apply", "inspect")).toBe(false);
    expect(isLegalTransition("validate", "prepare")).toBe(false);
  });

  it("allows moving to terminal sideways states from any non-terminal phase", () => {
    for (const start of [
      "inspect",
      "prepare",
      "apply",
      "restarting",
      "validate",
    ] as AssistedPhase[]) {
      expect(isLegalTransition(start, "rollback")).toBe(true);
      expect(isLegalTransition(start, "blocked")).toBe(true);
      expect(isLegalTransition(start, "failed")).toBe(true);
    }
  });

  it("forbids transitions out of terminal states", () => {
    for (const start of [
      "done",
      "rollback",
      "blocked",
      "failed",
    ] as AssistedPhase[]) {
      expect(isLegalTransition(start, "inspect")).toBe(false);
      expect(isLegalTransition(start, "validate")).toBe(false);
    }
    // Idempotent re-report of the same phase is allowed (the agent may
    // duplicate-post on retry).
    expect(isLegalTransition("done", "done")).toBe(true);
  });

  it("isTerminalPhase identifies the right set", () => {
    expect(isTerminalPhase("done")).toBe(true);
    expect(isTerminalPhase("rollback")).toBe(true);
    expect(isTerminalPhase("blocked")).toBe(true);
    expect(isTerminalPhase("failed")).toBe(true);
    expect(isTerminalPhase("inspect")).toBe(false);
    expect(isTerminalPhase("validate")).toBe(false);
  });
});
