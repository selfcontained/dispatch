// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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

    expect(onRunShortcut).toHaveBeenCalledWith(shortcutPin);
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
    expect(onRunShortcut).toHaveBeenCalledWith(pin);
  });

  it("does not fire the shortcut when the confirmation is cancelled", () => {
    const onRunShortcut = vi.fn();
    renderPanel([{ ...shortcutPin, confirm: true }], { onRunShortcut });

    fireEvent.click(screen.getByRole("button", { name: /work on/i }));
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    expect(onRunShortcut).not.toHaveBeenCalled();
    expect(screen.queryByTestId("pin-shortcut-confirm-dialog")).toBeNull();
  });

  it("disables the shortcut while the agent is not running", () => {
    renderPanel([shortcutPin], {
      agentIsRunning: false,
      onRunShortcut: vi.fn(),
    });

    const button = screen.getByRole("button", {
      name: /work on sse-reconnect/i,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("disables a shortcut that has no stable ID", () => {
    // Legacy/seeded rows without an ID cannot be addressed by the run
    // endpoint; a live-looking button that no-ops on click is worse.
    const { id: _id, ...withoutId } = shortcutPin;
    renderPanel([withoutId as AgentPin], { onRunShortcut: vi.fn() });

    const button = screen.getByRole("button", {
      name: /work on sse-reconnect/i,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
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
    expect(within(groups[0]!).getAllByRole("button")).toHaveLength(2);
  });

  it("disables the shortcut when no run handler is wired (e.g. agent history)", () => {
    renderPanel([shortcutPin]);

    const button = screen.getByRole("button", {
      name: /work on sse-reconnect/i,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});
