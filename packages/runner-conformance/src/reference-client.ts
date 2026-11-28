/*
 * A reference client for the runner protocol that uses only the protocol and
 * client packages. It knows nothing about the product that normally drives a
 * runner: it accepts a remote runner's TLS connection (or would spawn a local
 * runner), then drives a session through a turn and a guarded command.
 */
import { createServer, type TLSSocket } from "node:tls";
import { LocalSocketConnection } from "@dispatch/runner-client/transport/local-socket";
import { operationChannel } from "@dispatch/runner-client/session";
import {
  runnerIdFromWire,
  sessionFromWire,
  type Event,
  type Res,
  type Req,
  type Runner,
} from "@dispatch/runner-protocol/contract";
import { checked } from "./checked.js";
import { launchRequest, promptSession } from "./session.js";

export type Credentials = { key: string; cert: string; ca: string };

export type Accepted = {
  runner: Runner;
  close(): void;
};

/**
 * Listens for one remote runner. Resolves `port` once listening and
 * `accepted` once the runner has authenticated and answered its first description call.
 */
export function acceptRemoteRunner(
  credentials: Credentials,
  { host = "0.0.0.0", runnerId = "remote" } = {}
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
      socket.once("close", () => sockets.delete(socket));
      const connection = LocalSocketConnection.fromAuthenticatedSocket(socket);
      void connection
        .call("runner.describe", {})
        .then((reported) => {
          const description = {
            ...reported,
            runnerId: runnerIdFromWire(runnerId),
          };
          const runner: Runner = {
            describe: () => description,
            connection: {
              get state() {
                return connection.connected ? "ready" : "closed";
              },
              epoch: 1,
              onChange: (listen) => connection.onClose(() => listen("closed")),
            },
            call: (op, request, options) =>
              connection.call(op, request, {
                signal: options?.signal,
                onEvent: (event) =>
                  options?.onEvent?.(event as Event<typeof op>),
              }),
            async open(op, request, options) {
              const { info, channel } = await connection.openChannel(
                op,
                request,
                options
              );
              return { info, channel: operationChannel(op, channel) };
            },
          };
          resolve({ runner, close: () => connection.close() });
        })
        .catch((error) => {
          socket.destroy();
          reject(error);
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
      mode: "command-manifest",
      encoding: "utf8",
      maxBytes: null,
    });
    if (file?.data !== guard.content || !file.digest)
      throw new Error("The guard file did not read back with a digest.");
    const exec = await runner.call("checkout.exec", {
      target,
      guard: {
        path: guard.path,
        digest: file.digest,
      },
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
