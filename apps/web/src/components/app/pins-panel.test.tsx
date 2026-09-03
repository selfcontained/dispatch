// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentPin } from "@/components/app/types";

import { PinsPanel } from "./pins-panel";

afterEach(cleanup);

const shortcutPin: AgentPin = {
  id: "pin_1",
  label: "Work on sse-reconnect",
  value: "work on sse-eventsource-reconnect",
  type: "shortcut",
  caption: "High priority",
};

/** N shortcut pins sharing one group. Group names are unique per test so the
 * persisted collapse atoms cannot leak between them. */
function groupOf(group: string, count: number): AgentPin[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${group}_${index}`,
    label: `${group} pin ${index}`,
    value: `prompt ${index}`,
    type: "shortcut" as const,
    group,
  }));
}

function renderPanel(
  pins: AgentPin[],
  props: Partial<Parameters<typeof PinsPanel>[0]> = {}
) {
  return render(
    <PinsPanel
      pins={pins}
      selectedAgentName="agent"
      selectedAgentWorkspaceRoot={null}
      agentIsRunning
      {...props}
    />
  );
}

describe("shortcut pins", () => {
  it("renders the label as the button and the caption beneath it", () => {
    renderPanel([shortcutPin], { onRunShortcut: vi.fn() });

    expect(
      screen.getByRole("button", { name: /work on sse-reconnect/i })
    ).toBeTruthy();
    expect(screen.getByTestId("pin-caption").textContent).toBe("High priority");
  });

  it("fires the shortcut directly when the pin needs no confirmation", () => {
    const onRunShortcut = vi.fn();
    renderPanel([shortcutPin], { onRunShortcut });

    fireEvent.click(screen.getByRole("button", { name: /work on/i }));

    expect(onRunShortcut).toHaveBeenCalledWith(shortcutPin, null);
  });

  it("asks for confirmation first when the pin sets confirm", () => {
    const onRunShortcut = vi.fn();
    const pin = { ...shortcutPin, confirm: true };
    renderPanel([pin], { onRunShortcut });

    fireEvent.click(screen.getByRole("button", { name: /work on/i }));
    expect(onRunShortcut).not.toHaveBeenCalled();

    // The dialog shows the exact prompt before it is sent.
    expect(
      screen.getByTestId("pin-shortcut-confirm-dialog").textContent
    ).toContain("work on sse-eventsource-reconnect");

    fireEvent.click(screen.getByTestId("pin-shortcut-confirm"));
    expect(onRunShortcut).toHaveBeenCalledWith(pin, null);
  });

  it("does not fire the shortcut when the confirmation is cancelled", () => {
    const onRunShortcut = vi.fn();
    renderPanel([{ ...shortcutPin, confirm: true }], { onRunShortcut });

    fireEvent.click(screen.getByRole("button", { name: /work on/i }));
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    expect(onRunShortcut).not.toHaveBeenCalled();
    expect(screen.queryByTestId("pin-shortcut-confirm-dialog")).toBeNull();
  });

  it("marks the shortcut unavailable while the agent is not running", () => {
    // aria-disabled rather than the native attribute: the button stays
    // focusable so its tooltip can explain why it cannot be used.
    const onRunShortcut = vi.fn();
    renderPanel([shortcutPin], { agentIsRunning: false, onRunShortcut });

    const button = screen.getByRole("button", {
      name: /work on sse-reconnect/i,
    });
    expect(button.getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(button);
    expect(onRunShortcut).not.toHaveBeenCalled();
  });

  it("disables a shortcut that has no stable ID", () => {
    // Legacy/seeded rows without an ID cannot be addressed by the run
    // endpoint; a live-looking button that no-ops on click is worse.
    const { id: _id, ...withoutId } = shortcutPin;
    const onRunShortcut = vi.fn();
    renderPanel([withoutId as AgentPin], { onRunShortcut });

    const button = screen.getByRole("button", {
      name: /work on sse-reconnect/i,
    });
    expect(button.getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(button);
    expect(onRunShortcut).not.toHaveBeenCalled();
  });

  it("forces confirmation on a coarse pointer, where the tooltip is unreachable", () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes("coarse"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;

    try {
      const onRunShortcut = vi.fn();
      renderPanel([shortcutPin], { onRunShortcut });

      fireEvent.click(screen.getByRole("button", { name: /work on/i }));

      expect(onRunShortcut).not.toHaveBeenCalled();
      expect(
        screen.getByTestId("pin-shortcut-confirm-dialog").textContent
      ).toContain("work on sse-eventsource-reconnect");
    } finally {
      window.matchMedia = original;
    }
  });

  it("forces confirmation on a touch tap from a fine-pointer device", () => {
    // Hybrid laptops report `pointer: fine`, so the media query alone would
    // let a finger tap fire without ever showing the prompt.
    const onRunShortcut = vi.fn();
    renderPanel([shortcutPin], { onRunShortcut });

    const button = screen.getByRole("button", { name: /work on/i });
    // jsdom's fireEvent.click builds a MouseEvent, which has no pointerType,
    // so dispatch a native event carrying it.
    const tap = new MouseEvent("click", { bubbles: true });
    Object.defineProperty(tap, "pointerType", { value: "touch" });
    fireEvent(button, tap);

    expect(onRunShortcut).not.toHaveBeenCalled();
    expect(screen.getByTestId("pin-shortcut-confirm-dialog")).toBeTruthy();
  });

  it("renders pins sharing a group under one heading", () => {
    const other: AgentPin = {
      id: "pin_2",
      label: "Re-scan",
      value: "re-scan the inbox",
      type: "shortcut",
      group: "Ready to build",
    };
    renderPanel([{ ...shortcutPin, group: "Ready to build" }, other], {
      onRunShortcut: vi.fn(),
    });

    const groups = screen.getAllByTestId("pin-group");
    expect(groups).toHaveLength(1);
    expect(groups[0]!.getAttribute("data-pin-group")).toBe("Ready to build");
    // Two shortcuts plus the heading's own collapse toggle.
    expect(within(groups[0]!).getAllByRole("button")).toHaveLength(3);
  });

  it("marks the shortcut unavailable when no run handler is wired (e.g. agent history)", () => {
    renderPanel([shortcutPin]);

    const button = screen.getByRole("button", {
      name: /work on sse-reconnect/i,
    });
    expect(button.getAttribute("aria-disabled")).toBe("true");
  });

  it("renders a disabled shortcut as non-interactive with its caption as the reason", () => {
    // Disabling retires an action without deleting the pin — the caption
    // slot doubles as the reason (e.g. "already building — agt_...").
    const onRunShortcut = vi.fn();
    const pin = {
      ...shortcutPin,
      disabled: true,
      caption: "already building — agt_abc123",
    };
    renderPanel([pin], { onRunShortcut });

    const button = screen.getByRole("button", {
      name: /work on sse-reconnect/i,
    });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByTestId("pin-caption").textContent).toBe(
      "already building — agt_abc123"
    );

    fireEvent.click(button);
    expect(onRunShortcut).not.toHaveBeenCalled();
  });

  it("falls back to a generic reason caption when a disabled shortcut has none of its own", () => {
    // The tooltip needs a hover, which touch devices can't reach — a
    // disabled pin must still show *some* explanation without one.
    const { caption: _caption, ...withoutCaption } = shortcutPin;
    const onRunShortcut = vi.fn();
    renderPanel([{ ...withoutCaption, disabled: true } as AgentPin], {
      onRunShortcut,
    });

    expect(screen.getByTestId("pin-caption").textContent).toBe(
      "This action is currently unavailable."
    );
  });

  it("shows the member count on the group heading", () => {
    renderPanel(groupOf("Counted", 3), { onRunShortcut: vi.fn() });

    expect(screen.getByTestId("pin-group-count").textContent).toBe("3");
  });

  it("leaves a small group expanded", () => {
    renderPanel(groupOf("Small", 3), { onRunShortcut: vi.fn() });

    const group = screen.getByTestId("pin-group");
    expect(group.getAttribute("data-pin-group-collapsed")).toBe("false");
    expect(within(group).getAllByTestId("pin-item")).toHaveLength(3);
  });

  it("starts a large group collapsed, hiding its members but not its count", () => {
    // A long group otherwise pushes every other group off screen.
    renderPanel(groupOf("Large", 12), { onRunShortcut: vi.fn() });

    const group = screen.getByTestId("pin-group");
    expect(group.getAttribute("data-pin-group-collapsed")).toBe("true");
    expect(within(group).queryAllByTestId("pin-item")).toHaveLength(0);
    expect(screen.getByTestId("pin-group-count").textContent).toBe("12");
  });

  it("toggles a group in both directions", () => {
    renderPanel(groupOf("Toggled", 2), { onRunShortcut: vi.fn() });

    const toggle = screen.getByTestId("pin-group-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(toggle);
    expect(
      screen.getByTestId("pin-group-toggle").getAttribute("aria-expanded")
    ).toBe("false");
    expect(screen.queryAllByTestId("pin-item")).toHaveLength(0);

    fireEvent.click(screen.getByTestId("pin-group-toggle"));
    expect(
      screen.getByTestId("pin-group-toggle").getAttribute("aria-expanded")
    ).toBe("true");
    expect(screen.getAllByTestId("pin-item")).toHaveLength(2);
  });

  it("keeps an expanded large group expanded when it gains a pin", () => {
    // The size default must not override a choice the user already made, or
    // expanding a big group would silently undo itself on the next pin.
    const { unmount } = renderPanel(groupOf("Sticky", 12), {
      onRunShortcut: vi.fn(),
      collapseScope: "agt_sticky",
    });
    fireEvent.click(screen.getByTestId("pin-group-toggle"));
    expect(screen.getAllByTestId("pin-item")).toHaveLength(12);
    unmount();

    renderPanel(groupOf("Sticky", 13), {
      onRunShortcut: vi.fn(),
      collapseScope: "agt_sticky",
    });
    expect(
      screen.getByTestId("pin-group").getAttribute("data-pin-group-collapsed")
    ).toBe("false");
  });

  it("ties the toggle to the member region and names the group by its text", () => {
    renderPanel(groupOf("Wired", 2), { onRunShortcut: vi.fn() });

    const toggle = screen.getByTestId("pin-group-toggle");
    const region = screen.getByTestId("pin-group-members");
    // aria-controls must resolve, so the region stays mounted while collapsed.
    expect(toggle.getAttribute("aria-controls")).toBe(region.id);
    // The group's accessible name is the heading text, not the whole button
    // (which also reads out the count and the collapse action).
    const group = screen.getByTestId("pin-group");
    const labelId = group.getAttribute("aria-labelledby")!;
    expect(document.getElementById(labelId)!.textContent).toBe("Wired");
  });

  it("keeps the member region mounted and marked hidden when collapsed", () => {
    renderPanel(groupOf("HiddenRegion", 12), { onRunShortcut: vi.fn() });

    const region = screen.getByTestId("pin-group-members");
    expect(region.hasAttribute("hidden")).toBe(true);
    expect(within(region).queryAllByTestId("pin-item")).toHaveLength(0);
  });

  it("keeps collapse ephemeral when no scope is given", () => {
    // Without a scope there is nothing to namespace by; persisting under a
    // shared fallback key would leak one list's state onto every other.
    const { unmount } = renderPanel(groupOf("Unscoped", 2));
    fireEvent.click(screen.getByTestId("pin-group-toggle"));
    expect(
      screen.getByTestId("pin-group").getAttribute("data-pin-group-collapsed")
    ).toBe("true");
    expect(
      Object.keys(localStorage).filter(
        (k) => k.includes("__unscoped__") || k.includes("unscoped::")
      )
    ).toHaveLength(0);
    unmount();

    renderPanel(groupOf("Unscoped", 2));
    expect(
      screen.getByTestId("pin-group").getAttribute("data-pin-group-collapsed")
    ).toBe("false");
  });

  it("does not share collapse state between two scopes", () => {
    const { unmount } = renderPanel(groupOf("Shared", 2), {
      collapseScope: "agt_one",
    });
    fireEvent.click(screen.getByTestId("pin-group-toggle"));
    unmount();

    renderPanel(groupOf("Shared", 2), { collapseScope: "agt_two" });
    expect(
      screen.getByTestId("pin-group").getAttribute("data-pin-group-collapsed")
    ).toBe("false");
  });

  it("blocks a second send while the first is still in flight", () => {
    const onRunShortcut = vi.fn();
    renderPanel([shortcutPin], { onRunShortcut, pendingPinId: "pin_1" });

    const button = screen.getByRole("button", { name: /work on/i });
    expect(button.getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(button);
    expect(onRunShortcut).not.toHaveBeenCalled();
  });
});

describe("sub agent owner switch", () => {
  const child = {
    id: "agt_child",
    name: "builder",
    status: "running" as const,
    workspaceRoot: "/repo/.worktrees/child",
  };
  const quiet = {
    id: "agt_quiet",
    name: "quiet",
    status: "stopped" as const,
    workspaceRoot: null,
  };
  const childPins: AgentPin[] = [
    { id: "child_pr", label: "PR", value: "https://example/pr/1", type: "pr" },
    {
      id: "child_go",
      label: "Merge it",
      value: "merge the PR",
      type: "shortcut",
    },
  ];

  beforeEach(() => {
    // Radix Select calls scrollIntoView when opening; jsdom lacks it.
    Element.prototype.scrollIntoView = vi.fn();
  });

  function openSwitch(): void {
    fireEvent.click(screen.getByTestId("pins-owner-switch"));
  }

  it("offers the agent and every sub agent, showing the agent's own pins by default", async () => {
    renderPanel([shortcutPin], {
      selectedAgentId: "agt_parent",
      subAgentPins: [
        { agent: child, pins: childPins },
        { agent: quiet, pins: [] },
      ],
    });
    const trigger = screen.getByTestId("pins-owner-switch");
    expect(trigger.textContent).toBe("agent1");
    expect(trigger.dataset.pinsOwner).toBe("agt_parent");
    expect(screen.getByRole("button", { name: /work on/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Merge it/ })).toBeNull();
    openSwitch();
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "agent1",
      "builder2",
      "quiet0",
    ]);
  });

  it("swaps to a sub agent's pins and fires its shortcut at that sub agent", async () => {
    const onRunShortcut = vi.fn();
    renderPanel([shortcutPin], {
      selectedAgentId: "agt_parent",
      onRunShortcut,
      subAgentPins: [{ agent: child, pins: childPins }],
    });
    openSwitch();
    fireEvent.click(await screen.findByRole("option", { name: /^builder/ }));
    expect(screen.getByTestId("pins-owner-switch").dataset.pinsOwner).toBe(
      "agt_child"
    );
    expect(screen.queryByRole("button", { name: /work on/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Merge it/ }));
    expect(onRunShortcut).toHaveBeenCalledWith(childPins[1], "agt_child");
  });

  it("keeps the switch visible when the chosen sub agent has no pins", async () => {
    renderPanel([shortcutPin], {
      selectedAgentId: "agt_parent",
      subAgentPins: [{ agent: quiet, pins: [] }],
    });
    openSwitch();
    fireEvent.click(await screen.findByRole("option", { name: /^quiet/ }));
    expect(screen.getByText("quiet has no pins yet.")).toBeTruthy();
    expect(screen.getByTestId("pins-owner-switch")).toBeTruthy();
  });

  it("renders no switch without sub agents", () => {
    renderPanel([shortcutPin], { selectedAgentId: "agt_parent" });
    expect(screen.queryByTestId("pins-owner-switch")).toBeNull();
  });
});
