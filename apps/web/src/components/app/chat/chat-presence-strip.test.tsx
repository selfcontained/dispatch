// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatFeedEntry } from "@dispatch/shared";
import type { Agent } from "@/components/app/types";
import {
  agentToolBlipAtomFamily,
  terminalOutputActivityAtomFamily,
} from "@/lib/store";

import {
  ChatPresenceStrip,
  OUTPUT_ACTIVE_MS,
  QUIET_AFTER_MS,
  TOOL_BLIP_MS,
  latestTurnUpdatedAt,
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

const idle = { lastOutputAt: 0, bytesPerSecond: 0 };

describe("presenceState", () => {
  it("shows the phase without dots when no output has been observed", () => {
    const state = presenceState(agent(), idle, null, NOW);
    expect(state.label).toBe("Working");
    expect(state.detail).toEqual({ kind: "phase", text: "Running tests" });
  });

  it("animates while output flowed in the last three seconds", () => {
    const active = {
      lastOutputAt: NOW - OUTPUT_ACTIVE_MS + 1,
      bytesPerSecond: 40,
    };
    expect(presenceState(agent(), active, null, NOW).detail).toEqual({
      kind: "active",
      text: "Running tests",
    });
    const stale = {
      lastOutputAt: NOW - OUTPUT_ACTIVE_MS - 1,
      bytesPerSecond: 0,
    };
    expect(presenceState(agent(), stale, null, NOW).detail.kind).toBe("phase");
  });

  it("names a stall once a working agent has been silent for a minute", () => {
    const quiet = { lastOutputAt: NOW - QUIET_AFTER_MS, bytesPerSecond: 0 };
    expect(presenceState(agent(), quiet, null, NOW).detail).toEqual({
      kind: "quiet",
      minutes: 1,
    });
    const longer = { lastOutputAt: NOW - 3.5 * 60_000, bytesPerSecond: 0 };
    expect(presenceState(agent(), longer, null, NOW).detail).toEqual({
      kind: "quiet",
      minutes: 3,
    });
    // A done/idle agent is not stalled, just finished.
    const done = agent({
      latestEvent: {
        type: "done",
        message: "All green",
        updatedAt: "",
        metadata: null,
      },
    });
    expect(presenceState(done, longer, null, NOW).detail).toEqual({
      kind: "phase",
      text: "All green",
    });
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
    const active = { lastOutputAt: NOW, bytesPerSecond: 10 };
    const state = presenceState(waiting, active, null, NOW);
    expect(state.label).toBe("Waiting");
    expect(state.colorClass).toBe("text-status-waiting");
    expect(state.detail).toEqual({ kind: "phase", text: "Merge now?" });
  });

  it("overlays a tool blip for four seconds", () => {
    const blip = { tool: "dispatch_share_file", at: NOW - TOOL_BLIP_MS + 1 };
    expect(presenceState(agent(), idle, blip, NOW).detail).toEqual({
      kind: "tool",
      text: "sharing a file",
    });
    const expired = { tool: "dispatch_share_file", at: NOW - TOOL_BLIP_MS };
    expect(presenceState(agent(), idle, expired, NOW).detail.kind).toBe(
      "phase"
    );
  });

  it("falls back to the status text when the agent is not running", () => {
    const stopped = agent({ status: "stopped" });
    const state = presenceState(
      stopped,
      { lastOutputAt: NOW, bytesPerSecond: 1 },
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

  /** A dispatch agent's feed: a turn whose `updatedAt` the caller advances. */
  function renderHarnessStrip(updatedAt: string) {
    const full = { id: "agt_1", name: "demo", ...agent() } as Agent;
    const entry = {
      type: "turn",
      id: "t1",
      agentId: "agt_1",
      at: "2026-09-17T10:00:00.000Z",
      updatedAt,
      prompt: { text: "go" },
      trace: { startedAt: "2026-09-17T10:00:00.000Z", steps: [] },
      result: null,
      settled: false,
      interrupted: false,
    } as unknown as ChatFeedEntry;
    const store = createStore();
    const view = render(
      <Provider store={store}>
        <ChatPresenceStrip agentId="agt_1" agent={full} entries={[entry]} />
      </Provider>
    );
    return {
      rerender: (next: string) =>
        view.rerender(
          <Provider store={store}>
            <ChatPresenceStrip
              agentId="agt_1"
              agent={full}
              entries={[{ ...entry, updatedAt: next } as ChatFeedEntry]}
            />
          </Provider>
        ),
    };
  }

  it("keeps a streaming dispatch agent out of quiet with a silent pane", () => {
    // No terminal output at all, which is what a dispatch agent looks like:
    // its engine writes to the feed, not the pane.
    const { rerender } = renderHarnessStrip(new Date(NOW).toISOString());
    const strip = screen.getByTestId("chat-presence");

    act(() => {
      vi.advanceTimersByTime(QUIET_AFTER_MS + 5_000);
    });
    expect(strip.getAttribute("data-presence")).toBe("quiet");

    // A streamed row lands: the turn grows, so the agent is demonstrably alive.
    act(() => {
      rerender(new Date(Date.now()).toISOString());
    });
    expect(strip.getAttribute("data-presence")).toBe("active");
    expect(screen.queryByTestId("chat-presence-quiet")).toBeNull();
  });

  it("counts a stall that began before the pane was opened", () => {
    // The turn last moved four minutes ago and the pane is only now mounted;
    // stamping "now" on first sight would have reported a fresh agent.
    renderHarnessStrip(new Date(NOW - 4 * 60_000).toISOString());
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByTestId("chat-presence-quiet").textContent).toBe(
      "quiet for 4m"
    );
  });

  it("moves from dots to quiet as the terminal goes silent", () => {
    const store = renderStrip();
    act(() => {
      store.set(terminalOutputActivityAtomFamily("agt_1"), {
        lastOutputAt: Date.now(),
        bytesPerSecond: 120,
      });
    });
    const strip = screen.getByTestId("chat-presence");
    expect(strip.getAttribute("data-presence")).toBe("active");
    expect(screen.getByTestId("chat-presence-dots")).toBeTruthy();
    expect(strip.textContent).toContain("Running tests");

    act(() => {
      vi.advanceTimersByTime(OUTPUT_ACTIVE_MS + 1_000);
    });
    expect(strip.getAttribute("data-presence")).toBe("phase");
    expect(screen.queryByTestId("chat-presence-dots")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(QUIET_AFTER_MS);
    });
    expect(strip.getAttribute("data-presence")).toBe("quiet");
    expect(screen.getByTestId("chat-presence-quiet").textContent).toBe(
      "quiet for 1m"
    );
  });

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

describe("harness liveness", () => {
  const turnEntry = (updatedAt: string, settled: boolean) =>
    ({
      type: "turn",
      id: "t1",
      agentId: "agt_1",
      at: "2026-09-17T10:00:00.000Z",
      updatedAt,
      prompt: { text: "go" },
      trace: { startedAt: "2026-09-17T10:00:00.000Z", steps: [] },
      result: null,
      settled,
      interrupted: false,
    }) as unknown as ChatFeedEntry;

  it("reads the newest turn's updatedAt, open or settled", () => {
    expect(latestTurnUpdatedAt([])).toBeNull();
    expect(
      latestTurnUpdatedAt([turnEntry("2026-09-17T10:01:00.000Z", false)])
    ).toBe("2026-09-17T10:01:00.000Z");
    // Settled still counts: settling is the last thing the agent did.
    expect(
      latestTurnUpdatedAt([turnEntry("2026-09-17T10:02:00.000Z", true)])
    ).toBe("2026-09-17T10:02:00.000Z");
  });

  it("does not call a streaming harness agent quiet when its pane is silent", () => {
    // The tmux pane produced output once, on connect, and nothing since —
    // exactly what a dispatch agent looks like, because its engine writes to
    // the feed rather than the pane.
    const stalePane = { lastOutputAt: NOW - 5 * 60_000, bytesPerSecond: 0 };
    expect(presenceState(agent(), stalePane, null, NOW).detail).toEqual({
      kind: "quiet",
      minutes: 5,
    });
    expect(
      presenceState(agent(), stalePane, null, NOW, NOW - 500).detail
    ).toEqual({ kind: "active", text: "Running tests" });
  });

  it("still names a genuine stall when the turn itself stops moving", () => {
    const stalePane = { lastOutputAt: 0, bytesPerSecond: 0 };
    expect(
      presenceState(agent(), stalePane, null, NOW, NOW - 2.5 * 60_000).detail
    ).toEqual({ kind: "quiet", minutes: 2 });
  });

  it("takes whichever signal is newer", () => {
    const pane = { lastOutputAt: NOW - 1_000, bytesPerSecond: 10 };
    // Pane is fresh, feed is old: still active.
    expect(
      presenceState(agent(), pane, null, NOW, NOW - 10 * 60_000).detail.kind
    ).toBe("active");
  });
});
