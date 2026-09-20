import { describe, expect, it } from "vitest";

import {
  CENTER_TABS,
  centerTabLabel,
  centerTabRoute,
  isCenterTab,
} from "./center-tabs";

describe("center tabs registry", () => {
  it("offers Agent / Changes in order", () => {
    expect(CENTER_TABS.map((t) => t.id)).toEqual(["agent", "changes"]);
    expect(CENTER_TABS.map((t) => centerTabLabel(t.id))).toEqual([
      "Agent",
      "Changes",
    ]);
  });

  it("routes each tab", () => {
    expect(centerTabRoute("a1", "agent")).toBe("/agents/a1");
    expect(centerTabRoute("a1", "changes")).toBe("/agents/a1/changes");
  });

  it("recognises stored tab ids and rejects anything else", () => {
    expect(isCenterTab("agent")).toBe(true);
    expect(isCenterTab("terminal")).toBe(false);
    expect(isCenterTab("chat")).toBe(false);
    expect(isCenterTab("console")).toBe(false);
    expect(isCenterTab(null)).toBe(false);
    expect(isCenterTab(3)).toBe(false);
  });
});
