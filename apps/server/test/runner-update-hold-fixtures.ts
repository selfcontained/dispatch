/** Scripted agent hosts on real sockets, for runner update hold tests. */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";

import {
  encodeMessage,
  hostFile,
  ndjsonDecoder,
  type ClientMessage,
  type HostMessage,
} from "../src/agents/acp/host-protocol.js";

/** A host for one agent that accepts and settles every prompt at once. */
export async function scriptedHost(
  cleanup: Array<() => void>,
  stateRoot: string,
  agentId: string
) {
  const dir = path.join(stateRoot, agentId);
  mkdirSync(dir, { recursive: true });
  const host = spawn(
    process.execPath,
    ["-e", "setTimeout(() => {}, 120000)", "--", "agent-host", "--state", dir],
    { detached: true, stdio: "ignore" }
  );
  cleanup.push(() => host.kill());
  writeFileSync(hostFile(dir, "pid"), String(host.pid));
  const prompts: { text: string; images?: unknown }[] = [];
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
              steeringSupported: true,
              ...(message.replayComplete && { journalId: "journal" }),
            } satisfies HostMessage)
          );
          if (message.replayComplete)
            socket.write(encodeMessage({ type: "replay_complete" }));
        } else if (message.type === "prompt") {
          prompts.push({ text: message.text, images: message.images });
          socket.write(
            [
              event({ type: "turn", agentId, state: "started" }),
              { type: "prompt_accepted", id: message.id } satisfies HostMessage,
              event({ type: "turn", agentId, state: "settled" }),
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
  cleanup.push(() => server.close());
  return { prompts, socket: hostFile(dir, "socket") };
}
