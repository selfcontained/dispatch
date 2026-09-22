/**
 * The runtime's prompt queue against a scripted host on a real socket,
 * where the test decides how the host's messages are framed on the wire.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  encodeMessage,
  hostFile,
  ndjsonDecoder,
  type ClientMessage,
  type HostMessage,
} from "../src/agents/acp/host-protocol.js";
import { createAcpRuntime } from "../src/agents/acp/runtime.js";

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => logger,
  level: "silent",
} as unknown as Parameters<typeof createAcpRuntime>[0]["logger"];

const agentId = "agt_queue_test";
let cleanup: Array<() => void> = [];

afterEach(() => {
  for (const run of cleanup.splice(0)) run();
});

/**
 * A host that answers every prompt with a turn that fails at once, its
 * ack and both turn events written to the socket in a single chunk.
 */
async function fastFailingHost(): Promise<{
  stateRoot: string;
  prompts: string[];
}> {
  const stateRoot = mkdtempSync(path.join(os.tmpdir(), "dispatch-queue-"));
  const dir = path.join(stateRoot, agentId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(hostFile(dir, "pid"), String(process.pid));
  const prompts: string[] = [];
  let seq = 0;
  const event = (e: unknown): HostMessage =>
    ({
      type: "event",
      seq: ++seq,
      at: new Date().toISOString(),
      event: e,
    }) as HostMessage;
  const server = net.createServer((socket) => {
    const decode = ndjsonDecoder<ClientMessage>();
    socket.on("data", (chunk) => {
      for (const message of decode(chunk)) {
        if (message.type === "hello") {
          socket.write(
            encodeMessage({
              type: "welcome",
              agentId,
              engine: "claude",
              sessionId: "sess",
              resumed: false,
              running: true,
              turn: null,
              journalSeq: seq,
            } satisfies HostMessage)
          );
        } else if (message.type === "prompt") {
          prompts.push(message.text);
          socket.write(
            [
              event({
                type: "turn",
                agentId,
                state: "started",
                text: message.text,
              }),
              { type: "prompt_accepted", id: message.id } satisfies HostMessage,
              event({
                type: "turn",
                agentId,
                state: "settled",
                error: "API Error: 500",
                errorKind: "server_error",
              }),
            ]
              .map(encodeMessage)
              .join("")
          );
        }
      }
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(hostFile(dir, "socket"), resolve)
  );
  cleanup.push(() => {
    server.close();
    rmSync(stateRoot, { recursive: true, force: true });
  });
  return { stateRoot, prompts };
}

describe("AcpRuntime prompt queue", () => {
  it("takes the next prompt after a turn whose ack and settle arrive together", async () => {
    const { stateRoot, prompts } = await fastFailingHost();
    const runtime = createAcpRuntime({
      config: {
        agentStateRoot: stateRoot,
        agentRuntime: "acp",
        dispatchBinDir: "/nonexistent",
      },
      logger,
      hostSeq: async () => 0,
    });
    // No runtime.stop: the pid file names this test process.
    expect(await runtime.attach(agentId)).toBe(true);

    const first = runtime.prompt(agentId, "one");
    await first.accepted;
    await first.settled;
    expect(runtime.isBusy(agentId)).toBe(false);

    // The turn is over, so the next prompt goes straight to the host
    // rather than waiting on a settle that already happened.
    const second = runtime.prompt(agentId, "two");
    await Promise.race([
      second.accepted,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("second prompt never sent")), 2_000)
      ),
    ]);
    expect(prompts).toEqual(["one", "two"]);
  });
});
