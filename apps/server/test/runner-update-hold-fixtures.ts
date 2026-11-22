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
  const sockets = new Set<net.Socket>();
  const steers: string[] = [];
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
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
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
        } else if (message.type === "steer") {
          steers.push(message.text);
          socket.write(
            encodeMessage({
              type: "steer_result",
              id: message.id,
              outcome: "steered",
            } as HostMessage)
          );
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
  const close = () =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    });
  cleanup.push(() => close());
  return {
    prompts,
    steers,
    socket: hostFile(dir, "socket"),
    turn(state: "started" | "settled", source?: unknown) {
      const message = encodeMessage(
        event({ type: "turn", agentId, state, source })
      );
      for (const socket of sockets) socket.write(message);
    },
  };
}
