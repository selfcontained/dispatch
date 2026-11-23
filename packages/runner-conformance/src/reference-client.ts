/*
 * A reference client for the runner protocol that uses only the protocol and
 * client packages. It knows nothing about the product that normally drives a
 * runner: it accepts a remote runner's TLS connection (or would spawn a local
 * runner), describes it and runs a guarded command in a session's checkout.
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
  type Runner,
} from "@dispatch/runner-protocol/contract";
import { RunnerConnection } from "@dispatch/runner-client/v1/connection";
import { wireFrames } from "@dispatch/runner-client/v1/node";
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
      const send = wireFrames<unknown, ServiceFrame>(socket, (frame) => {
        if (!connection) {
          const ready = parseReadyFrame(frame);
          if (!ready) return socket.destroy();
          connection = new RunnerConnection(send);
          socket.on("close", () => connection?.close());
          const selected = workspace || ready.workspaces[0];
          if (!selected)
            return reject(new Error("The runner has no workspace."));
          resolve({
            ready,
            runner: v1Runner({
              connection,
              ready,
              runnerId,
              displayName: runnerId,
              workspace: selected,
            }),
            close: () => connection?.close(),
          });
          return;
        }
        const reply = frame as
          | ChannelFrame
          | ResultFrame
          | LaunchProgressFrame
          | { type: string };
        if (["result", "data", "close", "launch_progress"].includes(reply.type))
          connection.receive(reply as ResultFrame);
      });
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
};

/**
 * Describe the runner, then run a command in a session's checkout guarded by
 * a file the caller wrote there. `session` is any handle the caller chose.
 */
export async function walkthrough(
  runner: Runner,
  session: string,
  guard: { path: string; content: string }
): Promise<Walkthrough> {
  const description = runner.describe();
  const target = {
    session: sessionFromWire(session),
    checkout: "current",
  } as const;
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
  return { description, exec };
}
