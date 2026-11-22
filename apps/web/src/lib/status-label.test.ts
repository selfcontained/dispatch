import { describe, expect, it } from "vitest";

import { statusLabel } from "./status-label";

describe("statusLabel", () => {
  it.each([
    ["timed_out", "Timed out"],
    ["needs_input", "Needs input"],
    ["completed", "Completed"],
    ["trigger_launch_failed", "Trigger launch failed"],
    ["TIMED_OUT", "Timed out"],
    ["pre-flight", "Pre flight"],
    ["", ""],
  ])("labels %j as %j", (value, label) => {
    expect(statusLabel(value)).toBe(label);
  });
});
