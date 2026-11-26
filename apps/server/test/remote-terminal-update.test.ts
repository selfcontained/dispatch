import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CallerChannel,
  RunnerError,
} from "@dispatch/runner-protocol/contract";
import { TERMINAL_UPDATE_MESSAGE } from "../../../packages/runner/src/workload/agents/remote/update-admission.js";
import { HumanTerminalManager } from "../src/terminal/manager.js";
import { remoteTerminal } from "../src/terminal/remote.js";

let manager: HumanTerminalManager;
afterEach(() => manager.shutdown());

/** Exercise the enrolled terminal operation through the backend and manager. */
async function open() {
  type Channel = CallerChannel<"terminal.open">;
  let data!: Parameters<Channel["onData"]>[0];
  let close!: (error?: RunnerError) => void;
  const channel: Channel = {
    onData(listener) {
      data = listener;
      return () => {};
    },
    onClose(listener) {
      close = listener;
      return () => {};
    },
    write: vi.fn(),
    close: vi.fn(),
  };
  const openChannel = vi.fn(async () => ({
    info: { cwd: "/w", host: "runner", user: "u" },
    channel,
  }));
  manager = new HumanTerminalManager();
  const terminal = await manager.open(
    "owner",
    "tab",
    "agt_one",
    remoteTerminal({ open: openChannel } as never, "rnr_1", "agt_one")
  );
  expect(openChannel).toHaveBeenCalledExactlyOnceWith(
    "rnr_1",
    "terminal.open",
    {
      target: { session: "agt_one" },
      cols: 80,
      rows: 24,
    }
  );
  const socket = Object.assign(new EventEmitter(), {
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1,
    bufferedAmount: 0,
  });
  manager.attach(terminal.id, "owner", socket as unknown as WebSocket);
  const closes = (event?: Parameters<typeof data>[0]) => {
    if (event) data(event);
    close();
  };
  return { socket, closes, close };
}

describe("remote terminal update closure", () => {
  it("closes the pane's socket with the update notice", async () => {
    const { socket, closes } = await open();
    closes({ type: "error", message: "closed", reason: "update" });
    await vi.waitFor(() =>
      expect(socket.close).toHaveBeenCalledExactlyOnceWith(
        1000,
        TERMINAL_UPDATE_MESSAGE
      )
    );
  });

  it.each([
    ["another error", { type: "error", message: "full" }],
    ["a lost connection", undefined],
  ])("keeps the generic reason for %s", async (_case, event) => {
    const { socket, closes } = await open();
    closes(event);
    await vi.waitFor(() =>
      expect(socket.close).toHaveBeenCalledExactlyOnceWith(
        1000,
        "Runner terminal connection ended."
      )
    );
  });

  it("preserves the update reason on the negotiated credit channel", async () => {
    const { socket, close } = await open();
    close({ code: "fenced", message: "Runner update." });
    await vi.waitFor(() =>
      expect(socket.close).toHaveBeenCalledExactlyOnceWith(
        1000,
        TERMINAL_UPDATE_MESSAGE
      )
    );
  });

  it("fits in a WebSocket close reason", () => {
    expect(Buffer.byteLength(TERMINAL_UPDATE_MESSAGE)).toBeLessThanOrEqual(123);
  });
});
