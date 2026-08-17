import http from "node:http";
import https from "node:https";

import type { FastifyBaseLogger } from "fastify";

import type { TlsConfig } from "../config.js";

type TailnetListenerDeps = {
  /** The primary Fastify server — requests are re-emitted onto it. */
  appServer: () => http.Server;
  port: number;
  tls: TlsConfig | null;
  log: FastifyBaseLogger;
};

/**
 * A secondary listener bound to the tailnet IP that delegates every request
 * and upgrade to the primary Fastify server. Delegation (rather than a TCP
 * proxy) preserves request.socket.remoteAddress, which peer auth must feed
 * to `tailscale whois` — a proxy would report 127.0.0.1 for every caller.
 */
export class TailnetListener {
  private server: http.Server | https.Server | null = null;
  private boundAddress: string | null = null;
  // closeAllConnections() does not cover upgraded (WebSocket) sockets, so we
  // track every accepted socket and destroy them ourselves on stop.
  private readonly sockets = new Set<import("node:net").Socket>();

  constructor(private readonly deps: TailnetListenerDeps) {}

  get address(): string | null {
    return this.boundAddress;
  }

  /** True when `localAddress` is the tailnet interface this listener bound. */
  /**
   * Whether a connection arrived on a loopback interface. First-run open mode
   * is gated on this: a request from anywhere else is a remote caller, and
   * "no password set" must never mean "answer them".
   */
  static isLoopback(localAddress: string | undefined): boolean {
    if (!localAddress) return false;
    // Node reports IPv4 as ::ffff:127.0.0.1 on dual-stack sockets.
    const address = localAddress.startsWith("::ffff:")
      ? localAddress.slice(7)
      : localAddress;
    return (
      address === "::1" || address === "127.0.0.1" || address.startsWith("127.")
    );
  }

  isBoundAddress(localAddress: string | undefined): boolean {
    if (!this.boundAddress || !localAddress) return false;
    // Node reports IPv4 as ::ffff:100.x.y.z on dual-stack sockets.
    return (
      localAddress === this.boundAddress ||
      localAddress === `::ffff:${this.boundAddress}`
    );
  }

  async start(address: string): Promise<void> {
    if (this.server) {
      if (this.boundAddress === address) return;
      await this.stop();
    }
    const target = this.deps.appServer();
    const server = this.deps.tls
      ? https.createServer(this.deps.tls)
      : http.createServer();
    server.on("request", (req, res) => {
      target.emit("request", req, res);
    });
    server.on("upgrade", (req, socket, head) => {
      target.emit("upgrade", req, socket, head);
    });
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once("error", onError);
      server.listen(this.deps.port, address, () => {
        server.off("error", onError);
        resolve();
      });
    });
    this.server = server;
    this.boundAddress = address;
    this.deps.log.info(
      `Peer listener bound to tailnet interface ${address}:${this.deps.port}`
    );
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    this.boundAddress = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // close() waits for open connections (incl. SSE); cut them loose.
      server.closeAllConnections?.();
      for (const socket of this.sockets) socket.destroy();
      this.sockets.clear();
    });
    this.deps.log.info("Peer listener stopped");
  }
}
