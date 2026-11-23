/*
 * A reference client for the runner protocol that uses only the protocol and
 * client packages. It knows nothing about the product that normally drives a
 * runner: it accepts a remote runner's TLS connection (or would spawn a local
 * runner), then drives a session through a turn and a guarded command.
 */
import { createServer, type TLSSocket } from "node:tls";
import {
  parseReadyFrame,
  type ChannelFrame,
  type LaunchProgressFrame,
  type ReadyFrame,
  type ResultFrame,
  type ServiceFrame,
} from "@dispatch/runner-protocol";
import {
  sessionFromWire,
  type Res,
  type Req,
  type Runner,
} from "@dispatch/runner-protocol/contract";
import { RunnerConnection } from "@dispatch/runner-client/v1/connection";
import {
  FlowStreams,
  wireFrames,
  type StreamFrame,
} from "@dispatch/runner-client/v1/node";
import { checked } from "./checked.js";
import { launchRequest, promptSession } from "./session.js";
import { v1Runner } from "./v1-runner.js";

export type Credentials = { key: string; cert: string; ca: string };

export type Accepted = {
  runner: Runner;
  ready: ReadyFrame;
  close(): void;
};

/**
 * Listens for one remote runner. Resolves `port` once listening and
 * `accepted` once the runner has connected and sent `ready`.
 */
export function acceptRemoteRunner(
  credentials: Credentials,
  { host = "0.0.0.0", runnerId = "remote", workspace = "" } = {}
) {
  const server = createServer({
    ...credentials,
    requestCert: true,
    rejectUnauthorized: true,
  });
  const sockets = new Set<TLSSocket>();
  const accepted = new Promise<Accepted>((resolve, reject) => {
    server.on("error", reject);
    server.on("secureConnection", (socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      let connection: RunnerConnection | undefined;
      let streams: FlowStreams | undefined;
      const send = wireFrames<unknown, ServiceFrame | StreamFrame>(
        socket,
        (frame) => {
          if (!connection) {
            const ready = parseReadyFrame(frame);
            if (!ready) return socket.destroy();
            connection = new RunnerConnection(send);
            if (ready.streamCredit) {
              streams = new FlowStreams(socket, send);
              send({
                type: "stream",
                action: "accept",
                ...(ready.checkoutExecStream && { checkoutExecStream: true }),
              });
              streams.enable();
            }
            socket.on("close", () => connection?.close());
            const selected = workspace || ready.workspaces[0];
            if (!selected)
              return reject(new Error("The runner has no workspace."));
            resolve({
              ready,
              runner: v1Runner({
                connection,
                streams,
                ready,
                runnerId,
                displayName: runnerId,
                workspace: selected,
              }),
              close: () => connection?.close(),
            });
            return;
          }
          if (streams?.handle(frame)) return;
          const reply = frame as
            | ChannelFrame
            | ResultFrame
            | LaunchProgressFrame
            | { type: string };
          if (
            ["result", "data", "close", "launch_progress"].includes(reply.type)
          )
            connection.receive(reply as ResultFrame);
        }
      );
    });
  });
  const port = new Promise<number>((resolve) =>
    server.listen(0, host, () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    })
  );
  const close = () => {
    for (const socket of sockets) socket.destroy();
    server.close();
  };
  return { port, accepted, close };
}

/** The local runner program is started by its launcher; it does not exist yet. */
export async function spawnLocalRunner(): Promise<Runner> {
  throw new Error("There is no local runner program to spawn yet (L1).");
}

export type Walkthrough = {
  description: ReturnType<Runner["describe"]>;
  exec: Res<"checkout.exec">;
  events: Awaited<ReturnType<typeof promptSession>>["events"];
};

/**
 * Run one turn and a command guarded by a file the caller wrote in the checkout.
 */
export async function walkthrough(
  connection: Runner,
  session: string,
  guard: { path: string; content: string },
  config: Pick<Req<"session.launch">, "env" | "mcp"> & { prompt: string }
): Promise<Walkthrough> {
  const runner = checked(connection);
  const description = runner.describe();
  const handle = sessionFromWire(session);
  const { prompt, ...launch } = config;
  await runner.call("session.launch", launchRequest(handle, launch));
  try {
    const { events } = await promptSession(runner, handle, prompt);
    const target = { session: handle, checkout: "current" } as const;
    const file = await runner.call("checkout.read", {
      target,
      path: guard.path,
      encoding: "utf8",
      maxBytes: null,
    });
    if (file?.data !== guard.content || !file.digest)
      throw new Error("The guard file did not read back with a digest.");
    const exec = await runner.call("checkout.exec", {
      target,
      guard: { path: guard.path, digest: file.digest },
      argv: ["cat", guard.path],
      env: {},
      timeoutMs: null,
      maxOutput: null,
      shell: "direct",
    });
    return { description, exec, events };
  } finally {
    await runner.call("session.stop", { session: handle, force: false });
    await runner.call("session.discard", { session: handle });
  }
}
