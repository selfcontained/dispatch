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
});
