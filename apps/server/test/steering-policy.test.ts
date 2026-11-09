import { describe, expect, it } from "vitest";
import { selectSteeringChoice } from "../src/chat/steering-policy.js";

const result = (choice: string, probability: number, confidence: number) => ({
  choice,
  confidence,
  probabilities: [{ value: choice, probability }],
});
describe("shared steering confidence gate", () => {
  it("requires both probability and confidence, including at the boundary", () => {
    expect(selectSteeringChoice("ok", result("queue_next", 0.8, 0.8))).toBe(
      "queue_next"
    );
    expect(selectSteeringChoice("ok", result("queue_next", 0.99, 0.79))).toBe(
      "keep_existing_default"
    );
    expect(
      selectSteeringChoice("ok", result("steer_current", 0.79, 0.99))
    ).toBe("keep_existing_default");
  });
  it("preserves default for failed, missing, and unknown responses", () => {
    expect(selectSteeringChoice("timeout", result("steer_current", 1, 1))).toBe(
      "keep_existing_default"
    );
    expect(selectSteeringChoice("ok", {})).toBe("keep_existing_default");
    expect(selectSteeringChoice("ok", result("interrupt", 1, 1))).toBe(
      "keep_existing_default"
    );
  });
});
