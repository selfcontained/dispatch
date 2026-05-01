import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getCopyModeStateMock =
  vi.fn<
    () => Promise<{ inCopyMode: boolean; scrollPosition: number | null }>
  >();

vi.mock("../src/terminal/tmux-terminal.js", () => ({
  TmuxTerminal: class {
    constructor(_sessionName: string) {}

    async getCopyModeState() {
      return getCopyModeStateMock();
    }
  },
}));

const { CopyModeObserverManager } =
  await import("../src/terminal/copy-mode-observer.js");

beforeEach(() => {
  vi.useFakeTimers();
  getCopyModeStateMock.mockReset();
  getCopyModeStateMock.mockResolvedValue({
    inCopyMode: false,
    scrollPosition: null,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

async function flushObserver(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("CopyModeObserverManager", () => {
  it("publishes only on copy-mode changes", async () => {
    const events: Array<{
      agentId: string;
      terminalState: { copyMode: string };
    }> = [];
    const manager = new CopyModeObserverManager((event) => {
      events.push(event);
    });

    const detach = manager.attachViewer("agent-1", "session-1", "viewer-1");
    await flushObserver();

    expect(events).toEqual([
      expect.objectContaining({
        type: "agent.terminal_state_changed",
        agentId: "agent-1",
        terminalState: expect.objectContaining({ copyMode: "live" }),
      }),
    ]);

    await vi.advanceTimersByTimeAsync(2_500);
    expect(events).toHaveLength(1);
    detach();
  });

  it("holds exiting until tmux confirms live mode", async () => {
    let inCopyMode = true;
    getCopyModeStateMock.mockImplementation(async () => ({
      inCopyMode,
      scrollPosition: null,
    }));

    const events: string[] = [];
    const manager = new CopyModeObserverManager((event) => {
      events.push(event.terminalState.copyMode);
    });

    const detach = manager.attachViewer("agent-1", "session-1", "viewer-1");
    await flushObserver();
    expect(events).toEqual(["copy"]);

    manager.noteInteraction("agent-1", "session-1", "exit_copy_mode");
    expect(events).toEqual(["copy", "exiting"]);

    await vi.advanceTimersByTimeAsync(300);
    expect(events).toEqual(["copy", "exiting"]);

    inCopyMode = false;
    await vi.advanceTimersByTimeAsync(300);
    expect(events).toEqual(["copy", "exiting", "live"]);
    detach();
  });

  it("stops polling after the final viewer detaches", async () => {
    const manager = new CopyModeObserverManager(() => {});

    const detach = manager.attachViewer("agent-1", "session-1", "viewer-1");
    await flushObserver();
    expect(getCopyModeStateMock).toHaveBeenCalledTimes(1);

    detach();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(getCopyModeStateMock).toHaveBeenCalledTimes(1);
  });

  it("preserves exit-pending state across a quick reattach", async () => {
    let inCopyMode = true;
    getCopyModeStateMock.mockImplementation(async () => ({
      inCopyMode,
      scrollPosition: null,
    }));

    const events: string[] = [];
    const manager = new CopyModeObserverManager((event) => {
      events.push(event.terminalState.copyMode);
    });

    const detachFirst = manager.attachViewer(
      "agent-1",
      "session-1",
      "viewer-1"
    );
    await flushObserver();
    expect(events).toEqual(["copy"]);

    manager.noteInteraction("agent-1", "session-1", "exit_copy_mode");
    expect(events).toEqual(["copy", "exiting"]);

    detachFirst();
    await vi.advanceTimersByTimeAsync(1_000);

    const detachSecond = manager.attachViewer(
      "agent-1",
      "session-1",
      "viewer-2"
    );
    await flushObserver();
    expect(events).toEqual(["copy", "exiting"]);

    inCopyMode = false;
    await vi.advanceTimersByTimeAsync(300);
    expect(events).toEqual(["copy", "exiting", "live"]);
    detachSecond();
  });

  it("evicts no-viewer observers created by state reads", async () => {
    const manager = new CopyModeObserverManager(() => {});

    await manager.getState("agent-1", "session-1");
    expect(getCopyModeStateMock).toHaveBeenCalledTimes(1);

    getCopyModeStateMock.mockClear();
    await vi.advanceTimersByTimeAsync(2_500);

    await manager.getState("agent-1", "session-1");
    expect(getCopyModeStateMock).toHaveBeenCalledTimes(1);
  });
});
