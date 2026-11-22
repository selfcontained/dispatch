import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunnerConnection } from "@dispatch/runner-protocol/connection";
import type { ServiceFrame } from "@dispatch/runner-protocol";
import { TERMINAL_UPDATE_MESSAGE } from "../src/agents/remote/update-admission.js";
import { HumanTerminalManager } from "../src/terminal/manager.js";
import { remoteTerminal } from "../src/terminal/remote.js";

let manager: HumanTerminalManager;
afterEach(() => manager.shutdown());

/** The runner's frames through the real connection, backend and manager. */
async function open() {
  let id!: string;
  const connection = new RunnerConnection((frame: ServiceFrame) => {
    if (frame.type !== "request") return;
    id = frame.id;
    queueMicrotask(() =>
      connection.receive({
        type: "result",
        id,
        value: JSON.stringify({ cwd: "/w", host: "runner", user: "u" }),
      })
    );
  });
  const runner = {
    requestSession: () =>
      connection.request(
        { kind: "openTerminal", agentId: "agt_one", workspace: "@session" },
        { openChannel: true }
      ),
  };
  manager = new HumanTerminalManager();
  const terminal = await manager.open(
    "owner",
    "tab",
    "agt_one",
    remoteTerminal(
      runner as never,
      { runner: "rnr_1", workspace: "@session" },
      "agt_one"
    )
  );
  const socket = Object.assign(new EventEmitter(), {
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1,
    bufferedAmount: 0,
  });
  manager.attach(terminal.id, "owner", socket as unknown as WebSocket);
  /** What a runner writes when it closes a terminal, in one read. */
  const closes = (event?: object) => {
    if (event)
      connection.receive({
        type: "data",
        id,
        data: Buffer.from(JSON.stringify(event) + "\n").toString("base64"),
      });
    connection.receive({ type: "close", id });
  };
  return { socket, closes };
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

  it("fits in a WebSocket close reason", () => {
    expect(Buffer.byteLength(TERMINAL_UPDATE_MESSAGE)).toBeLessThanOrEqual(123);
  });
});
