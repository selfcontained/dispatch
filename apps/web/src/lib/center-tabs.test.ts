import { describe, expect, it } from "vitest";

import {
  CENTER_TABS,
  centerTabLabel,
  centerTabRoute,
  centerTabs,
  isCenterTab,
} from "./center-tabs";

describe("center tabs registry", () => {
  it("offers Chat only with the flag on, in display order", () => {
    expect(centerTabs(true).map((t) => t.id)).toEqual([
      "chat",
      "terminal",
      "changes",
      "whiteboard",
    ]);
    expect(centerTabs(false).map((t) => t.id)).toEqual([
      "terminal",
      "changes",
      "whiteboard",
    ]);
  });

  it("relabels the terminal Console under the flag and nothing else", () => {
    expect(centerTabLabel("terminal", false)).toBe("Terminal");
    expect(centerTabLabel("terminal", true)).toBe("Console");
    for (const tab of CENTER_TABS) {
      if (tab.id === "terminal") continue;
      expect(tab.label(true)).toBe(tab.label(false));
    }
  });

  it("routes every tab under the agent", () => {
    expect(centerTabRoute("a1", "terminal")).toBe("/agents/a1");
    expect(centerTabRoute("a1", "chat")).toBe("/agents/a1/chat");
    expect(centerTabRoute("a1", "changes")).toBe("/agents/a1/changes");
    expect(centerTabRoute("a1", "whiteboard")).toBe("/agents/a1/whiteboard");
  });

  it("recognises stored tab ids and rejects anything else", () => {
    expect(isCenterTab("chat")).toBe(true);
    expect(isCenterTab("terminal")).toBe(true);
    expect(isCenterTab("console")).toBe(false);
    expect(isCenterTab(null)).toBe(false);
    expect(isCenterTab(3)).toBe(false);
  });
});
