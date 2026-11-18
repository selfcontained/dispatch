import { X509Certificate } from "node:crypto";
import { readFileSync, watchFile, unwatchFile } from "node:fs";
import http from "node:http";
import https from "node:https";
import { connect as connectTcp, isIP } from "node:net";
import os from "node:os";
import { createServer, type Server, type TLSSocket } from "node:tls";
import type { Duplex } from "node:stream";
import type { Pool } from "pg";
import {
  hostChannel,
  wireFrames,
  type Command,
  type Frame,
  type Placement,
} from "./protocol.js";
import {
  formatHost,
  pairingCommand,
  RUNNER_NAME,
  type EnrollFrame,
} from "./enrollment.js";
import {
  PairingRejected,
  RunnerNameTaken,
  RunnerRegistry,
  type Registration,
} from "./registry.js";

/** The single manually approved registration of the original prototype. */
export type LegacyConfig = {
  id: string;
  host: string;
  port: number;
  cert: string;
  key: string;
  ca: string;
  approval: string;
  workspaces: string[];
  /** Guest-reachable HTTPS MCP origin. Defaults to this listener's proxy. */
  mcpOrigin?: string;
  /** Host the guest dials for the default MCP origin. */
  endpointHost?: string;
  repoTool?: boolean;
};

export type EnrollmentOptions = {
  registry: RunnerRegistry;
  /** Bind address for the runner listener. */
  host: string;
  /** Fixed listener port; otherwise the persisted (or first free) port. */
  port?: number;
  /** Host written into pairing commands and the listener certificate. */
  endpointHost?: string;
  /** External HTTPS MCP origin; defaults to the runner listener's proxy. */
  mcpOrigin?: string;
  repoTool?: boolean;
  log?: Pick<Console, "info" | "warn">;
};

export type RunnerStatus = "pending" | "online" | "offline" | "revoked";
export type RunnerSummary = {
  id: string;
  name: string;
  status: RunnerStatus;
  workspaces: string[];
};

export class RunnerUnavailable extends Error {}
export class RunnerHostGone extends Error {}
export class RunnerRequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

type Gate = {
  /** Runner name addressed by placements. */
  name: string;
  registrationId?: string;
  approved(): boolean;
  allows(workspace: string): boolean;
  ready?(workspaces: string[]): void;
};

type Settle = (frame?: Extract<Frame, { type: "result" }>) => void;

type Peer = {
  socket: TLSSocket;
  send: (frame: Frame) => void;
  workspaces: Set<string>;
  gate: Gate;
  pending: Map<string, Settle>;
  channels: Map<string, Duplex>;
};

const WORKSPACE = /^[a-z0-9-]+$/;
const LEGACY_PREFIX = "legacy-";
const MAX_UNAUTHENTICATED = 64;

function validHost(host: string) {
  return (
    isIP(host) > 0 ||
    /^[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$/.test(host)
  );
}

function httpsOrigin(value: string | undefined, label: string) {
  if (!value) return undefined;
  if (new URL(value).protocol !== "https:")
    throw new Error(`${label} must use HTTPS`);
  return value.replace(/\/$/, "");
}

export function configuredRunner(input?: {
  pool: Pool;
  host: string;
  apiPort: number;
  apiTls: boolean;
}) {
  const filename = process.env.DISPATCH_REMOTE_SERVICE_CONFIG;
  const legacy: LegacyConfig | undefined = filename
    ? JSON.parse(readFileSync(filename, "utf8"))
    : undefined;
  const enrollment: EnrollmentOptions | undefined =
    input && process.env.DISPATCH_RUNNERS !== "0"
      ? {
          registry: new RunnerRegistry(input.pool),
          host: process.env.DISPATCH_RUNNER_HOST ?? input.host,
          port: process.env.DISPATCH_RUNNER_PORT
            ? Number(process.env.DISPATCH_RUNNER_PORT)
            : undefined,
          endpointHost: process.env.DISPATCH_RUNNER_ENDPOINT_HOST,
          mcpOrigin: process.env.DISPATCH_RUNNER_MCP_ORIGIN,
          repoTool: process.env.DISPATCH_RUNNER_REPO_TOOL === "1",
          log: console,
        }
      : undefined;
  return legacy || enrollment
    ? new RemoteRunnerService(
        legacy,
        enrollment,
        input && { host: input.host, port: input.apiPort, tls: input.apiTls }
      )
    : undefined;
}

export class RemoteRunnerService {
  /** Connected runners by placement name; each is an independent peer. */
  private readonly peers = new Map<string, Peer>();
  /** Enrolled, unrevoked registrations by client certificate fingerprint. */
  private readonly enrolled = new Map<string, Registration>();
  private readonly legacySockets = new Set<TLSSocket>();
  private readonly sockets = new Set<TLSSocket>();
  private unauthenticated = 0;
  private legacyListener?: Server;
  private listener?: Server;
  private listening?: Promise<void>;
  private authority?: { caFingerprint: string; serverCert: string };
  private port?: number;
  private readonly proxy: http.Server;
  private proxyPort?: Promise<number>;

  constructor(
    private readonly legacy?: LegacyConfig,
    private readonly enrollment?: EnrollmentOptions,
    /** Local Dispatch API that the listeners proxy agent MCP requests to. */
    private readonly api?: { host: string; port: number; tls: boolean }
  ) {
    if (legacy) {
      httpsOrigin(legacy.mcpOrigin, "Runner MCP origin");
      if (!legacy.mcpOrigin && !legacy.endpointHost)
        throw new Error(
          "Runner service config needs mcpOrigin or endpointHost for MCP."
        );
    }
    if (enrollment) {
      httpsOrigin(enrollment.mcpOrigin, "DISPATCH_RUNNER_MCP_ORIGIN");
      if (enrollment.endpointHost && !validHost(enrollment.endpointHost))
        throw new Error("DISPATCH_RUNNER_ENDPOINT_HOST is not a valid host");
    }
    this.proxy = http.createServer((request, response) =>
      this.forward(request, response)
    );
    // MCP tool calls may legitimately run for a long time.
    this.proxy.requestTimeout = 0;
    this.proxy.headersTimeout = 30_000;
  }

  /** Origin for an agent's MCP URL as seen from the runner it is placed on. */
  originFor(placement: Placement) {
    if (this.legacy && placement.runner === this.legacy.id)
      return (
        httpsOrigin(this.legacy.mcpOrigin, "Runner MCP origin") ??
        `https://${formatHost(this.legacy.endpointHost!)}:${this.legacy.port}`
      );
    const configured = httpsOrigin(
      this.enrollment?.mcpOrigin,
      "DISPATCH_RUNNER_MCP_ORIGIN"
    );
    if (configured) return configured;
    const registration = this.registrationNamed(placement.runner);
    if (!registration || !this.port)
      throw new RunnerUnavailable("The runner is not enrolled.");
    return `https://${formatHost(registration.endpointHost)}:${this.port}`;
  }

  /** @deprecated Single-runner origin; prefer {@link originFor}. */
  get origin() {
    if (this.legacy)
      return this.originFor({ runner: this.legacy.id, workspace: "" });
    const first = [...this.enrolled.values()][0];
    if (!first) throw new RunnerUnavailable("No runner is enrolled.");
    return this.originFor({ runner: first.name, workspace: "" });
  }

  get repoTool() {
    return this.legacy?.repoTool === true || this.enrollment?.repoTool === true;
  }

  private registrationNamed(name: string) {
    for (const registration of this.enrolled.values())
      if (registration.name === name) return registration;
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Listeners
  // ---------------------------------------------------------------------------

  /** Start the legacy listener (no database needed). */
  async start() {
    const legacy = this.legacy;
    if (!legacy || this.legacyListener) return;
    const listener = createServer(
      {
        ca: readFileSync(legacy.ca),
        cert: readFileSync(legacy.cert),
        key: readFileSync(legacy.key),
        requestCert: true,
        rejectUnauthorized: false,
      },
      (socket) => this.accept(socket, "legacy")
    );
    this.legacyListener = listener;
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(legacy.port, legacy.host, resolve);
    });
    watchFile(
      legacy.approval,
      { interval: 500, persistent: false },
      this.recheckLegacy
    );
  }

  /** Start the enrolled listener when any registration exists. */
  async startEnrolled() {
    if (this.enrollment && (await this.enrollment.registry.hasActive()))
      await this.ensureListening();
  }

  private legacyApproved(socket: TLSSocket) {
    try {
      return (
        socket.authorized &&
        socket.getPeerCertificate().fingerprint256 ===
          readFileSync(this.legacy!.approval, "utf8").trim()
      );
    } catch {
      return false;
    }
  }

  private recheckLegacy = () => {
    for (const socket of this.legacySockets)
      if (!this.legacyApproved(socket)) socket.destroy();
  };

  private ensureListening(host?: string): Promise<void> {
    const run = async () => {
      const options = this.enrollment!;
      const authority = await options.registry.authority(
        host ? [host] : [options.endpointHost ?? "localhost"]
      );
      const context = {
        ca: authority.ca.cert,
        cert: authority.server.cert + authority.ca.cert,
        key: authority.server.key,
      };
      this.authority = {
        caFingerprint: new X509Certificate(authority.ca.cert).fingerprint256,
        serverCert: authority.server.cert,
      };
      for (const registration of await options.registry.active())
        this.enrolled.set(registration.fingerprint!, registration);
      if (this.listener) {
        this.listener.setSecureContext(context);
        return;
      }
      const listener = createServer(
        { ...context, requestCert: true, rejectUnauthorized: false },
        (socket) => this.accept(socket, "enrolled")
      );
      const listen = (port: number) =>
        new Promise<void>((resolve, reject) => {
          listener.once("error", reject);
          listener.listen(port, options.host, () => {
            listener.off("error", reject);
            resolve();
          });
        });
      const preferred = options.port ?? authority.port ?? 0;
      try {
        await listen(preferred);
      } catch (error) {
        if (
          options.port !== undefined ||
          preferred === 0 ||
          (error as NodeJS.ErrnoException).code !== "EADDRINUSE"
        )
          throw error;
        options.log?.warn(
          `Runner port ${preferred} is in use; enrolled runners must be re-paired.`
        );
        await listen(0);
      }
      this.listener = listener;
      const address = listener.address();
      this.port = typeof address === "object" && address ? address.port : 0;
      if (this.port !== authority.port)
        await options.registry.savePort(this.port);
      options.log?.info(
        `Dispatch runner listener on ${formatHost(options.host)}:${this.port}`
      );
    };
    const next = (this.listening ?? Promise.resolve())
      .catch(() => {})
      .then(run);
    this.listening = next;
    return next;
  }

  // ---------------------------------------------------------------------------
  // Connections
  // ---------------------------------------------------------------------------

  private accept(socket: TLSSocket, kind: "legacy" | "enrolled") {
    socket.on("error", () => socket.destroy());
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    if (socket.authorized) {
      const gate = this.gateFor(socket, kind);
      return gate ? this.attachPeer(socket, gate) : socket.destroy();
    }
    // Unauthenticated peers may pair once or reach the scoped MCP proxy.
    if (this.unauthenticated >= MAX_UNAUTHENTICATED) return socket.destroy();
    this.unauthenticated++;
    socket.once("close", () => this.unauthenticated--);
    const deadline = setTimeout(() => socket.destroy(), 10_000);
    socket.once("data", (chunk: Buffer) => {
      clearTimeout(deadline);
      if (chunk[0] === 0x7b && kind === "enrolled") {
        socket.pause();
        socket.unshift(chunk);
        this.pair(socket);
        socket.resume();
      } else if (
        /^[A-Z]{3,7} \//.test(chunk.subarray(0, 9).toString("latin1"))
      ) {
        void this.relay(socket, chunk);
      } else socket.destroy();
    });
  }

  /**
   * Hand an HTTP connection to the loopback proxy server, which checks every
   * request on it. Piping (rather than emitting the TLS socket into an
   * http.Server) works the same under Node and Bun.
   */
  private async relay(socket: TLSSocket, head: Buffer) {
    socket.pause();
    try {
      const port = await this.ensureProxy();
      if (socket.destroyed) return;
      const upstream = connectTcp(port, "127.0.0.1");
      upstream.on("error", () => socket.destroy());
      socket.on("close", () => upstream.destroy());
      upstream.on("close", () => socket.destroy());
      upstream.write(head);
      socket.pipe(upstream).pipe(socket);
      socket.resume();
    } catch {
      socket.destroy();
    }
  }

  private ensureProxy() {
    this.proxyPort ??= new Promise<number>((resolve, reject) => {
      this.proxy.once("error", reject);
      this.proxy.listen(0, "127.0.0.1", () => {
        const address = this.proxy.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });
    return this.proxyPort;
  }

  private gateFor(
    socket: TLSSocket,
    kind: "legacy" | "enrolled"
  ): Gate | undefined {
    if (kind === "legacy") {
      const legacy = this.legacy!;
      if (!this.legacyApproved(socket)) return undefined;
      this.legacySockets.add(socket);
      socket.once("close", () => this.legacySockets.delete(socket));
      return {
        name: legacy.id,
        approved: () => this.legacyApproved(socket),
        allows: (workspace) => legacy.workspaces.includes(workspace),
      };
    }
    const fingerprint = socket.getPeerCertificate().fingerprint256;
    const registration = this.enrolled.get(fingerprint);
    if (!registration) return undefined;
    const registry = this.enrollment!.registry;
    return {
      name: registration.name,
      registrationId: registration.id,
      approved: () => this.enrolled.get(fingerprint)?.id === registration.id,
      allows: () => true,
      ready: (workspaces) => {
        registration.workspaces = workspaces;
        void registry.connected(registration.id, workspaces).catch(() => {});
      },
    };
  }

  private attachPeer(socket: TLSSocket, gate: Gate) {
    const deadline = setTimeout(() => socket.destroy(), 5000);
    let peer: Peer | undefined;
    socket.on("close", () => {
      clearTimeout(deadline);
      if (!peer) return;
      if (this.peers.get(gate.name) === peer) this.peers.delete(gate.name);
      for (const settle of peer.pending.values()) settle();
      for (const channel of peer.channels.values()) channel.push(null);
      if (gate.registrationId)
        void this.enrollment?.registry
          .seen(gate.registrationId)
          .catch(() => {});
    });
    const send = wireFrames(socket, (frame) => {
      if (!gate.approved()) return socket.destroy();
      if (!peer) {
        if (
          frame.type !== "ready" ||
          frame.version !== 1 ||
          !Array.isArray(frame.workspaces) ||
          frame.workspaces.length > 256 ||
          !frame.workspaces.every(
            (workspace) =>
              typeof workspace === "string" && WORKSPACE.test(workspace)
          )
        )
          return socket.destroy();
        clearTimeout(deadline);
        peer = {
          socket,
          send,
          workspaces: new Set(frame.workspaces),
          gate,
          pending: new Map(),
          channels: new Map(),
        };
        // A reconnect replaces a half-open predecessor for the same runner.
        const previous = this.peers.get(gate.name);
        this.peers.set(gate.name, peer);
        previous?.socket.destroy();
        gate.ready?.(frame.workspaces);
        return;
      }
      if (frame.type === "result") peer.pending.get(frame.id)?.(frame);
      else if (frame.type === "data")
        peer.channels.get(frame.id)?.push(Buffer.from(frame.data, "base64"));
      else if (frame.type === "close") peer.channels.get(frame.id)?.push(null);
      else socket.destroy();
    });
  }

  private pair(socket: TLSSocket) {
    let used = false;
    const reply = (frame: EnrollFrame) => {
      try {
        send(frame as unknown as Frame);
      } catch {
        /* closed */
      }
      socket.end();
    };
    const send = wireFrames(socket, (frame) => {
      if (used) return socket.destroy();
      used = true;
      const request = frame as unknown as EnrollFrame;
      if (
        request.type !== "enroll" ||
        request.version !== 1 ||
        typeof request.code !== "string" ||
        request.code.length > 128 ||
        typeof request.publicKey !== "string" ||
        request.publicKey.length > 8192
      )
        return reply({
          type: "enroll_error",
          error: "Invalid pairing request.",
        });
      this.enrollment!.registry.redeem(request.code, request.publicKey).then(
        ({ registration, cert, ca }) => {
          this.enrolled.set(registration.fingerprint!, registration);
          reply({
            type: "enrolled",
            id: registration.id,
            name: registration.name,
            cert,
            ca,
          });
        },
        (error) => {
          // Slow down code guessing; codes carry 160 bits regardless.
          setTimeout(
            () =>
              reply({
                type: "enroll_error",
                error:
                  error instanceof PairingRejected
                    ? error.message
                    : "Pairing failed.",
              }),
            500
          );
        }
      );
    });
  }

  /** Forward only bearer-authenticated agent MCP calls to the local API. */
  private forward(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ) {
    const url = request.url ?? "";
    const ping = url === "/ping" && request.method === "GET";
    const mcp =
      /^\/api\/mcp\/agt_[a-z0-9]+$/.test(url) &&
      /^Bearer \S+$/.test(request.headers.authorization ?? "");
    const target = this.api;
    if ((!ping && !mcp) || !target) {
      response.writeHead(ping || mcp ? 503 : 404).end();
      return;
    }
    const host =
      target.host === "0.0.0.0"
        ? "127.0.0.1"
        : target.host === "::"
          ? "::1"
          : target.host;
    const headers = { ...request.headers };
    for (const name of [
      "cookie",
      "host",
      "origin",
      "referer",
      "forwarded",
      "x-forwarded-for",
      "x-forwarded-host",
      "x-forwarded-proto",
    ])
      delete headers[name];
    const upstream = (target.tls ? https : http).request(
      {
        host,
        port: target.port,
        method: request.method,
        path: url,
        headers: { ...headers, host: `${formatHost(host)}:${target.port}` },
        // The API is on this machine; its certificate names its LAN hosts.
        rejectUnauthorized: false,
      },
      (reply) => {
        response.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(response);
      }
    );
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    response.on("close", () => upstream.destroy());
    request.pipe(upstream);
  }

  // ---------------------------------------------------------------------------
  // Registration management (control API)
  // ---------------------------------------------------------------------------

  async list(): Promise<RunnerSummary[]> {
    const runners: RunnerSummary[] = [];
    if (this.legacy) {
      const peer = this.peers.get(this.legacy.id);
      runners.push({
        id: `${LEGACY_PREFIX}${this.legacy.id}`,
        name: this.legacy.id,
        status: peer?.gate.approved() ? "online" : "offline",
        workspaces: peer
          ? [...peer.workspaces].filter((w) =>
              this.legacy!.workspaces.includes(w)
            )
          : [...this.legacy.workspaces],
      });
    }
    if (!this.enrollment) return runners;
    for (const registration of await this.enrollment.registry.list()) {
      const peer = this.peers.get(registration.name);
      const online =
        !registration.revoked &&
        peer?.gate.registrationId === registration.id &&
        peer.gate.approved();
      runners.push({
        id: registration.id,
        name: registration.name,
        status: registration.revoked
          ? "revoked"
          : !registration.enrolled
            ? "pending"
            : online
              ? "online"
              : "offline",
        workspaces: online ? [...peer!.workspaces] : registration.workspaces,
      });
    }
    return runners;
  }

  async createRegistration(name: unknown, hostHint?: string) {
    if (!this.enrollment)
      throw new RunnerRequestError(409, "Runner enrollment is disabled.");
    if (typeof name !== "string" || !RUNNER_NAME.test(name))
      throw new RunnerRequestError(
        400,
        "Runner names use lowercase letters, digits and hyphens (1-40 characters)."
      );
    if (this.legacy?.id === name)
      throw new RunnerRequestError(
        409,
        `A runner named "${name}" already exists.`
      );
    const host = this.enrollment.endpointHost ?? hostHint ?? os.hostname();
    if (!validHost(host))
      throw new RunnerRequestError(400, "The runner endpoint host is invalid.");
    await this.ensureListening(host);
    try {
      const { id, code, expiresAt } = await this.enrollment.registry.create(
        name,
        host
      );
      return {
        id,
        command: pairingCommand({
          host,
          port: this.port!,
          caFingerprint: this.authority!.caFingerprint,
          code,
        }),
        expiresAt: expiresAt.toISOString(),
      };
    } catch (error) {
      if (error instanceof RunnerNameTaken)
        throw new RunnerRequestError(409, error.message);
      throw error;
    }
  }

  /** Revoke a registration and drop its live connection immediately. */
  async revoke(id: string) {
    if (id.startsWith(LEGACY_PREFIX) && this.legacy)
      throw new RunnerRequestError(
        409,
        "This runner is configured by DISPATCH_REMOTE_SERVICE_CONFIG; empty its approval file to revoke it."
      );
    if (!this.enrollment)
      throw new RunnerRequestError(404, "Runner not found.");
    const registration = await this.enrollment.registry.revoke(id);
    if (!registration) throw new RunnerRequestError(404, "Runner not found.");
    for (const [fingerprint, entry] of this.enrolled)
      if (entry.id === id) this.enrolled.delete(fingerprint);
    for (const peer of this.peers.values())
      if (peer.gate.registrationId === id) peer.socket.destroy();
  }

  // ---------------------------------------------------------------------------
  // Agent operations
  // ---------------------------------------------------------------------------

  available(placement: Placement) {
    const peer = this.peers.get(placement.runner);
    return Boolean(
      peer &&
      peer.gate.approved() &&
      peer.gate.allows(placement.workspace) &&
      peer.workspaces.has(placement.workspace)
    );
  }

  async request(placement: Placement, command: Command, open = false) {
    const peer = this.peers.get(placement.runner);
    if (
      !peer ||
      !this.available(placement) ||
      command.workspace !== placement.workspace
    ) {
      throw new RunnerUnavailable(
        "The enrolled runner is disconnected or the workspace is unavailable."
      );
    }
    const id = crypto.randomUUID();
    const channel = open
      ? hostChannel(id, peer.send, () => peer.channels.delete(id))
      : undefined;
    // The HostClient takes over error handling after the attach acknowledgement.
    channel?.on("error", () => {});
    if (channel) peer.channels.set(id, channel);
    try {
      const value = await new Promise<boolean | string | undefined>(
        (resolve, reject) => {
          const finish: Settle = (frame) => {
            clearTimeout(timer);
            peer.pending.delete(id);
            if (!frame)
              reject(
                new RunnerUnavailable(
                  "Runner acknowledgement was lost; execution is unknown."
                )
              );
            else if (frame.code === "host-gone")
              reject(new RunnerHostGone(frame.error));
            else if (frame.error) reject(new Error(frame.error));
            else resolve(frame.value);
          };
          const timer = setTimeout(() => finish(), 20_000);
          peer.pending.set(id, finish);
          try {
            peer.send({ type: "request", id, command });
          } catch {
            finish();
          }
        }
      );
      return { value, channel };
    } catch (error) {
      channel?.destroy();
      throw error;
    }
  }

  close() {
    if (this.legacy) unwatchFile(this.legacy.approval, this.recheckLegacy);
    for (const socket of this.sockets) socket.destroy();
    this.legacyListener?.close();
    this.listener?.close();
    if (this.proxyPort) this.proxy.close();
  }
}
