// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Agent } from "@/components/app/types";
import { agentToolBlipAtomFamily } from "@/lib/store";

import {
  ChatPresenceStrip,
  TOOL_BLIP_MS,
  presenceState,
  toolBlipLabel,
} from "./chat-presence-strip";

const NOW = 1_800_000_000_000;

function agent(
  overrides: Partial<Pick<Agent, "status" | "latestEvent">> = {}
): Pick<Agent, "status" | "latestEvent"> {
  return {
    status: "running",
    latestEvent: {
      type: "working",
      message: "Running tests",
      updatedAt: "2026-09-03T10:00:00.000Z",
      metadata: null,
    },
    ...overrides,
  };
}

describe("presenceState", () => {
  it("shows the phase of a working agent", () => {
    const state = presenceState(agent(), null, NOW);
    expect(state.label).toBe("Working");
    expect(state.detail).toEqual({ kind: "phase", text: "Running tests" });
  });

  it("keeps the waiting and blocked states and their colours", () => {
    const waiting = agent({
      latestEvent: {
        type: "waiting_user",
        message: "Merge now?",
        updatedAt: "",
        metadata: null,
      },
    });
    const state = presenceState(waiting, null, NOW);
    expect(state.label).toBe("Waiting");
    expect(state.colorClass).toBe("text-status-waiting");
    expect(state.detail).toEqual({ kind: "phase", text: "Merge now?" });
  });

  it("overlays a tool blip for four seconds", () => {
    const blip = { tool: "dispatch_share_file", at: NOW - TOOL_BLIP_MS + 1 };
    expect(presenceState(agent(), blip, NOW).detail).toEqual({
      kind: "tool",
      text: "sharing a file",
    });
    const expired = { tool: "dispatch_share_file", at: NOW - TOOL_BLIP_MS };
    expect(presenceState(agent(), expired, NOW).detail.kind).toBe("phase");
  });

  it("falls back to the status text when the agent is not running", () => {
    const stopped = agent({ status: "stopped" });
    const state = presenceState(
      stopped,
      { tool: "dispatch_pin", at: NOW },
      NOW
    );
    expect(state.label).toBe("Stopped");
    expect(state.detail).toEqual({ kind: "phase", text: null });
  });
});

describe("toolBlipLabel", () => {
  it("maps the known tools and humanises the rest", () => {
    expect(toolBlipLabel("dispatch_share_file")).toBe("sharing a file");
    expect(toolBlipLabel("dispatch_pins")).toBe("pinning");
    expect(toolBlipLabel("dispatch_chat_update")).toBe("posting to chat");
    expect(toolBlipLabel("dispatch_launch_agent")).toBe("launching an agent");
    expect(toolBlipLabel("brain_store_object")).toBe("saving notes");
    expect(toolBlipLabel("dispatch_surface_update")).toBe("surface update");
    expect(toolBlipLabel("repo_dev_up")).toBe("dev up");
  });
});

describe("ChatPresenceStrip", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  function renderStrip(store = createStore()) {
    const full = { id: "agt_1", name: "demo", ...agent() } as Agent;
    render(
      <Provider store={store}>
        <ChatPresenceStrip agentId="agt_1" agent={full} />
      </Provider>
    );
    return store;
  }

  it("shows a tool blip and drops it after four seconds", () => {
    const store = renderStrip();
    act(() => {
      store.set(agentToolBlipAtomFamily("agt_1"), {
        tool: "dispatch_chat_post",
        at: Date.now(),
      });
    });
    expect(screen.getByTestId("chat-presence-tool").textContent).toBe(
      "posting to chat"
    );
    act(() => {
      vi.advanceTimersByTime(TOOL_BLIP_MS + 1_000);
    });
    expect(screen.queryByTestId("chat-presence-tool")).toBeNull();
    expect(screen.getByTestId("chat-presence").textContent).toContain(
      "Running tests"
    );
  });
});
