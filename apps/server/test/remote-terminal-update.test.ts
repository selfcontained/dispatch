import { Duplex } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  RUNNER_UPDATE_TERMINAL_NOTICE,
  remoteTerminal,
} from "../src/terminal/remote.js";

function open() {
  const channel = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const toClient = { write: (line: string) => channel.push(line) };
  const runner = {
    requestSession: vi.fn(async () => ({
      value: JSON.stringify({ cwd: "/w", host: "runner", user: "u" }),
      channel,
    })),
  };
  const output = vi.fn();
  const backend = remoteTerminal(
    runner as never,
    { runner: "rnr_1", workspace: "@session" },
    "agt_one"
  );
  return { toClient, output, started: backend(output) };
}

describe("remote terminal update closure", () => {
  it("shows the update reason before the terminal ends", async () => {
    const { toClient, output, started } = open();
    const terminal = await started;
    toClient.write(
      JSON.stringify({ type: "error", message: "closed", reason: "update" }) +
        "\n"
    );
    await expect(terminal.exited).resolves.toBeNull();
    expect(output).toHaveBeenCalledWith(
      Buffer.from(RUNNER_UPDATE_TERMINAL_NOTICE)
    );
  });

  it("keeps other errors silent", async () => {
    const { toClient, output, started } = open();
    const terminal = await started;
    toClient.write(JSON.stringify({ type: "error", message: "full" }) + "\n");
    await expect(terminal.exited).resolves.toBeNull();
    expect(output).not.toHaveBeenCalled();
  });
});
