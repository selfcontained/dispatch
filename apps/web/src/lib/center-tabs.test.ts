import { describe, expect, it } from "vitest";

import {
  CENTER_TABS,
  centerTabLabel,
  centerTabRoute,
  centerTabs,
  isCenterTab,
  terminalHostTab,
} from "./center-tabs";

describe("center tabs registry", () => {
  it("offers the Agent pane with the flag on and the Terminal with it off", () => {
    expect(centerTabs(true).map((t) => t.id)).toEqual([
      "agent",
      "changes",
      "whiteboard",
    ]);
    expect(centerTabs(false).map((t) => t.id)).toEqual([
      "terminal",
      "changes",
      "whiteboard",
    ]);
  });

  it("labels the tabs Agent / Terminal / Changes / Whiteboard", () => {
    expect(centerTabLabel("agent")).toBe("Agent");
    expect(centerTabLabel("terminal")).toBe("Terminal");
    expect(centerTabLabel("changes")).toBe("Changes");
    expect(centerTabLabel("whiteboard")).toBe("Whiteboard");
    expect(CENTER_TABS.map((t) => t.label)).toEqual([
      "Agent",
      "Terminal",
      "Changes",
      "Whiteboard",
    ]);
  });

  it("routes the Agent pane and the Terminal to the bare agent route", () => {
    expect(centerTabRoute("a1", "agent")).toBe("/agents/a1");
    expect(centerTabRoute("a1", "terminal")).toBe("/agents/a1");
    expect(centerTabRoute("a1", "changes")).toBe("/agents/a1/changes");
    expect(centerTabRoute("a1", "whiteboard")).toBe("/agents/a1/whiteboard");
  });

  it("names the terminal-hosting tab per flag value", () => {
    expect(terminalHostTab(true)).toBe("agent");
    expect(terminalHostTab(false)).toBe("terminal");
  });

  it("recognises stored tab ids and rejects anything else", () => {
    expect(isCenterTab("agent")).toBe(true);
    expect(isCenterTab("terminal")).toBe(true);
    // The round-1/2 chat tab is no longer a tab of its own.
    expect(isCenterTab("chat")).toBe(false);
    expect(isCenterTab("console")).toBe(false);
    expect(isCenterTab(null)).toBe(false);
    expect(isCenterTab(3)).toBe(false);
  });
});
