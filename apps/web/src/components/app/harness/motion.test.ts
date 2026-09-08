import { describe, expect, it } from "vitest";

import { DURATION, EASE, rowDelay, STAGGER_CAP, STAGGER_S } from "./motion";

describe("motion tokens", () => {
  it("has the three durations and two easings from the spec", () => {
    expect(DURATION).toEqual({ fast: 0.12, base: 0.2, slow: 0.32 });
    expect(EASE.standard).toEqual([0.2, 0, 0, 1]);
    expect(EASE.exit).toEqual([0.4, 0, 1, 1]);
  });
  it("staggers rows 20 ms apart, capped at five", () => {
    expect(rowDelay(0)).toBe(0);
    expect(rowDelay(2)).toBeCloseTo(2 * STAGGER_S);
    expect(rowDelay(40)).toBeCloseTo(STAGGER_CAP * STAGGER_S);
  });
});
