import { describe, expect, it } from "vitest";
import { canSubmitFeedback } from "./feedback-form";

describe("canSubmitFeedback", () => {
  const ready = {
    busy: false,
    hasSelection: true,
    selectedAgentId: "agent-1",
    comment: "Make this purple",
  };

  it("enables submission when every field is ready", () => {
    expect(canSubmitFeedback(ready)).toBe(true);
  });

  it.each([
    { busy: true },
    { hasSelection: false },
    { selectedAgentId: "" },
    { comment: "   " },
  ])("keeps submission disabled for %o", (override) => {
    expect(canSubmitFeedback({ ...ready, ...override })).toBe(false);
  });
});
