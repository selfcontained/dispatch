import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { isIP, type Socket } from "node:net";
import type { FastifyInstance } from "fastify";
import type { TlsConfig } from "./config.js";

export function parseListenHosts(
  value: string | undefined
): string[] | undefined {
  if (value === undefined) return undefined;
  const hosts = value.split(",").map((host) => host.trim());
  if (
    !hosts.length ||
    hosts.length > 16 ||
    hosts.some((host) => !isIP(host)) ||
    new Set(hosts).size !== hosts.length
  ) {
    throw new Error(
      "DISPATCH_LISTEN_HOSTS must contain 1–16 distinct IP addresses"
    );
  }
  if (
    hosts.length > 1 &&
    hosts.some((host) => host === "0.0.0.0" || host === "::")
  ) {
    throw new Error(
      "Wildcard and individual listen addresses cannot be combined"
    );
  }
  return hosts;
}

/** Additional sockets share Fastify's router, hooks, auth, and websocket handler.
 * No proxying or wildcard listener broadens the user's chosen address set.
 */
export async function listenAdditionalHosts(
  app: FastifyInstance,
  hosts: string[],
  port: number,
  tls: TlsConfig | null = null
): Promise<() => Promise<void>> {
  const listeners: ReturnType<typeof createHttpServer>[] = [];
  const sockets = new Set<Socket>();
  const close = async () => {
    const pending = listeners.map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve()))
    );
    for (const socket of sockets) socket.destroy();
    await Promise.all(pending);
  };
  try {
    for (const host of hosts) {
      const handler = app.routing.bind(app);
      const server = tls
        ? createHttpsServer(tls, handler)
        : createHttpServer(handler);
      listeners.push(server);
      server.requestTimeout = app.server.requestTimeout;
      server.headersTimeout = app.server.headersTimeout;
      server.keepAliveTimeout = app.server.keepAliveTimeout;
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      });
      server.on("upgrade", (request, socket, head) => {
        if (!app.server.emit("upgrade", request, socket, head))
          socket.destroy();
      });
      server.on("error", (error) =>
        app.log.error({ error, host }, "Additional listener error")
      );
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => reject(error);
        server.once("error", failed);
        server.listen({ host, port, ipv6Only: host.includes(":") }, () => {
          server.removeListener("error", failed);
          resolve();
        });
      });
    }
    return close;
  } catch (error) {
    await close();
    throw error;
  }
}
