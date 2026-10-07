// Ported from @mytraai/promptkit (MytraAI/mytra-os-uis, packages/promptkit):
// Nii Yeboah's PromptKit design. Adapted to Dispatch's tokens and shadcn.
import { describe, expect, it } from "vitest";
import { formatStepDuration } from "./format";

describe("formatStepDuration", () => {
  it("renders sub-second durations as whole milliseconds", () => {
    expect(formatStepDuration(920)).toBe("920ms");
  });

  it("renders one-second-and-over durations as seconds with one decimal", () => {
    expect(formatStepDuration(7200)).toBe("7.2s");
  });

  it("reads a long turn in minutes and seconds", () => {
    expect(formatStepDuration(125_000)).toBe("2m 5s");
  });

  it("rounds to the nearest second past a minute", () => {
    expect(formatStepDuration(125_600)).toBe("2m 6s");
  });

  it("drops the seconds when a duration lands on the minute", () => {
    expect(formatStepDuration(120_000)).toBe("2m");
  });

  it("reads hours and minutes past an hour", () => {
    expect(formatStepDuration(3_840_000)).toBe("1h 4m");
    expect(formatStepDuration(7_200_000)).toBe("2h");
  });
});
