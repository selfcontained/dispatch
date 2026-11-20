import { isEngineCapabilityOperation } from "@dispatch/runner-protocol/engine-management";
import {
  githubPullRequestUrl,
  githubPullRequestTarget,
  projectPullRequest,
} from "../pull-request-reader.js";
import { X509Certificate } from "node:crypto";
import { readFileSync, watchFile, unwatchFile } from "node:fs";
import http from "node:http";
import https from "node:https";
import { connect as connectTcp, isIP, type Socket } from "node:net";
import os from "node:os";
import { createServer, type Server, type TLSSocket } from "node:tls";
import {
  RunnerConnection,
  RunnerUnavailable,
} from "@dispatch/runner-protocol/connection";
export {
  RunnerUnavailable,
  RunnerHostGone,
} from "@dispatch/runner-protocol/connection";
import type { Pool } from "pg";
import type { FastifyBaseLogger } from "fastify";
import {
  parseRunnerHealth,
  type RunnerHealth,
  parseReadyFrame,
  type ConnectCreated,
  type ConnectPoll,
  type ServiceFrame,
  type RunnerFrame,
  type EnrollmentRequest,
  type EnrollmentReply,
  MANAGED_WORKSPACE,
  wireFrames,
  parseEngineInventory,
  type Command,
  type RunnerOperation,
  type GitHubOperation,
  type GitHubStatus,
  type GitHubPullRequestWatchEvent,
  isGitHubPullRequestTarget,
  parseGitHubPullRequestWatchEvent,
  MAX_PULL_REQUEST_WATCH_EVENT_BYTES,
  parseGitHubStatus,
  isGitHubPullRequestObservation,
  isGitHubPullRequestDetails,
  isGitHubPullRequestDiff,
  githubPullRequestHead,
  githubRepositoryResults,
  validBranch,
  type SessionOperation,
  type LaunchProgress,
  parseLaunchProgress,
  type EngineInventoryEntry,
  type Placement,
} from "./protocol.js";
import {
  connectCliCommand,
  formatHost,
  pairingCommand,
  validRunnerName,
} from "./enrollment.js";
import {
  ConnectRequestInvalid,
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
  /** Public web origin when the operator UI has a separate listener or proxy. */
  approvalOrigin?: string;
  /**
   * Service-side approval for the runner's fixed repo operation: true for
   * every placement, or a list of `<registrationId>` / `<registrationId>/<workspace>`.
   */
  repoTool?: boolean | string[];
  log?: Pick<Console, "info" | "warn">;
};

export type RunnerStatus = "pending" | "online" | "offline" | "revoked";
export type RunnerSummary = {
  id: string;
  name: string;
  status: RunnerStatus;
  health?: RunnerHealth;
  healthReceivedAt?: string;
  /** Whether this (online) peer advertised support for engine management. */
  engineManagement: boolean;
  engineCapabilities?: true;
  githubManagement: boolean;
  repositoryPicker?: boolean;
  /** Last pushed snapshot while online; absent offline or before the first push. */
  engines?: EngineInventoryEntry[];
  workspaces: string[];
  managedWorkspace?: true;
};

export class RunnerCapabilityUnavailable extends Error {}

export class RunnerRevoked extends RunnerUnavailable {
  static readonly reason =
    "The runner registration was revoked. Dispatch no longer has access to this session.";
  constructor() {
    super(RunnerRevoked.reason);
  }
}
export class RunnerRequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

type Gate = {
  /** Runner component of placements: the registration id (or legacy id). */
  key: string;
  registrationId?: string;
  approved(): boolean;
  allows(workspace: string): boolean;
  ready?(workspaces: string[], managedWorkspace: boolean): void;
};

type Peer = {
  socket: TLSSocket;
  connection: RunnerConnection;
  workspaces: Set<string>;
  managedWorkspace: boolean;
  gate: Gate;
  health?: { sample: RunnerHealth; receivedAt: Date };
  reportsHealth?: boolean;
  engineCapabilities: boolean;
  /** Advertised in `ready`; whether this peer answers the `"engine"` command. */
  engineManagement: boolean;
  githubManagement: boolean;
  repositoryPicker?: boolean;
  pullRequestStatus: boolean;
  pullRequestWatch: boolean;
  pullRequestEvidence: boolean;
  checkoutInspection: boolean;
  checkoutMetadata: boolean;
  checkoutCommands: boolean;
  terminals: boolean;
  defaultBranchFiles: boolean;
  sessionCheckout: boolean;
  checkoutRelease: boolean;
  sessionFiles: boolean;
  sessionFileTail?: Promise<unknown>;
  checkoutViews: boolean;
  sharedWorktree: boolean;
  workspacePreparation: boolean;
  /** Last pushed, validated engine inventory; absent until the runner first reports one. */
  engines?: EngineInventoryEntry[];
};

const MAX_UNAUTHENTICATED = 64;
const MAX_HTTP_RELAYS = 256;
const UNAUTHENTICATED_TIMEOUT = 10_000;
const PROXY_KEEP_ALIVE_TIMEOUT = 75_000;

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

/**
 * Unlike the MCP origin, the approval link may legitimately be plain HTTP
 * (a Vite dev server) as well as HTTPS (production), so only its shape —
 * a bare http(s) origin, no path — is checked here.
 */
function anyOrigin(value: string | undefined, label: string) {
  if (!value) return undefined;
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error(`${label} must be an http(s) origin`);
  if (url.pathname !== "/" || url.search || url.hash)
    throw new Error(`${label} must be a bare origin, without a path`);
  return value.replace(/\/$/, "");
}

function isLoopbackHost(host: string) {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    bare === "localhost" ||
    bare.endsWith(".localhost") ||
    bare === "::1" ||
    bare === "0.0.0.0" ||
    bare === "::" ||
    /^127\./.test(bare) ||
    /^::ffff:127\./.test(bare)
  );
}

/**
 * The host written into pairing commands. A browser on the Dispatch machine
 * itself reaches it via loopback, which a remote runner cannot use, so fall
 * back to this machine's LAN address (private IPv4 first), then its hostname.
 */
export function advertisedHost(
  hint: string | undefined,
  interfaces: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces(),
  hostname = os.hostname()
) {
  if (hint && !isLoopbackHost(hint)) return hint.replace(/^\[|\]$/g, "");
  const addresses = Object.values(interfaces)
    .flat()
    .filter(
      (entry): entry is os.NetworkInterfaceInfo =>
        Boolean(entry) && !entry!.internal && entry!.family === "IPv4"
    )
    .map((entry) => entry.address)
    .filter((address) => !address.startsWith("169.254."));
  const isPrivate = (address: string) =>
    /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address);
  return (
    addresses.find(isPrivate) ??
    addresses[0] ??
    (isLoopbackHost(hostname) ? "localhost" : hostname)
  );
}

function parseRepoTool(value: string | undefined): boolean | string[] {
  if (!value || value === "0") return false;
  if (value === "1" || value === "*") return true;
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function configuredRunner(input?: {
  pool: Pool;
  host: string;
  apiPort: number;
  apiTls: boolean;
  logger?: Pick<FastifyBaseLogger, "debug">;
  validAgentToken?: (token: string, agentId: string) => boolean;
  validJobToken?: (token: string, runId: string, agentId: string) => boolean;
}) {
  const filename = process.env.DISPATCH_REMOTE_SERVICE_CONFIG;
  const legacy: LegacyConfig | undefined = filename
    ? JSON.parse(readFileSync(filename, "utf8"))
    : undefined;
  const enrollment: EnrollmentOptions | undefined =
    input && process.env.DISPATCH_RUNNERS !== "0"
      ? {
          registry: new RunnerRegistry(input.pool),
          // Runners are remote by definition: a loopback-only API (the
          // desktop default) must not make the runner listener loopback-only.
          // The listener only opens once a registration exists.
          host: process.env.DISPATCH_RUNNER_HOST ?? "0.0.0.0",
          port: process.env.DISPATCH_RUNNER_PORT
            ? Number(process.env.DISPATCH_RUNNER_PORT)
            : undefined,
          endpointHost: process.env.DISPATCH_RUNNER_ENDPOINT_HOST,
          mcpOrigin: process.env.DISPATCH_RUNNER_MCP_ORIGIN,
          approvalOrigin: process.env.DISPATCH_RUNNER_APPROVAL_ORIGIN,
          repoTool: parseRepoTool(process.env.DISPATCH_RUNNER_REPO_TOOL),
          log: console,
        }
      : undefined;
  return legacy || enrollment
    ? new RemoteRunnerService(
        legacy,
        enrollment,
        input && {
          host: input.host,
          port: input.apiPort,
          tls: input.apiTls,
          validAgentToken: input.validAgentToken,
          validJobToken: input.validJobToken,
        },
        input?.logger
      )
    : undefined;
}

export class RemoteRunnerService {
  /** Connected runners by placement name; each is an independent peer. */
  private readonly connectionListeners = new Set<(runnerId: string) => void>();
  onConnectionChange(listener: (runnerId: string) => void) {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }
  private readonly peers = new Map<string, Peer>();
  /** Enrolled, unrevoked registrations by client certificate fingerprint. */
  private readonly enrolled = new Map<string, Registration>();
  private readonly legacySockets = new Set<TLSSocket>();
  private readonly sockets = new Set<TLSSocket>();
  private unauthenticated = 0;
  private activeHttpRelays = 0;
  private readonly maxHttpRelays = MAX_HTTP_RELAYS;
  private legacyListener?: Server;
  private listener?: Server;
  private listening?: Promise<void>;
  private authority?: {
    caFingerprint: string;
    caPem: string;
    serverCert: string;
  };
  private port?: number;
  private readonly proxy: http.Server;
  private proxyPort?: Promise<number>;

  constructor(
    private readonly legacy?: LegacyConfig,
    private readonly enrollment?: EnrollmentOptions,
    /** Local Dispatch API that the listeners proxy agent MCP requests to. */
    private readonly api?: {
      host: string;
      port: number;
      tls: boolean;
      /** Accept only session-scoped MCP credentials through the proxy. */
      validAgentToken?: (token: string, agentId: string) => boolean;
      validJobToken?: (
        token: string,
        runId: string,
        agentId: string
      ) => boolean;
    },
    private readonly logger?: Pick<FastifyBaseLogger, "debug">
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
      anyOrigin(enrollment.approvalOrigin, "DISPATCH_RUNNER_APPROVAL_ORIGIN");
      if (enrollment.endpointHost && !validHost(enrollment.endpointHost))
        throw new Error("DISPATCH_RUNNER_ENDPOINT_HOST is not a valid host");
    }
    this.proxy = http.createServer(
      {
        // MCP tool calls may legitimately run for a long time.
        requestTimeout: 0,
        headersTimeout: 30_000,
        // Manage keep-alive below because Bun ignores this option.
        keepAliveTimeout: 0,
      },
      (request, response) => {
        const relay = this.proxyRelays.get(request.socket.remotePort!);
        if (relay) {
          response.once("finish", () => relay.requestsServed++);
        }
        this.trackProxyRequest(request.socket, response);
        this.forward(request, response, () => {
          relay?.releaseHandshake?.();
          if (relay) relay.releaseHandshake = undefined;
        });
      }
    );
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
    const registration = this.registrationById(placement.runner);
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
    return this.originFor({ runner: first.id, workspace: "" });
  }

  /** @deprecated Whether any placement may use the repo operation. */
  get repoTool() {
    const enrolled = this.enrollment?.repoTool;
    return (
      this.legacy?.repoTool === true ||
      enrolled === true ||
      (Array.isArray(enrolled) && enrolled.length > 0)
    );
  }

  /**
   * Whether the service approves the runner's fixed repo operation for this
   * placement. Requires an agent-MCP-eligible registration; the runner still
   * requires its own per-workspace `repoTool`.
   */
  repoToolFor(placement: Placement) {
    if (this.isManagedWorkspace(placement) || !this.permitsAgentMcp(placement))
      return false;
    if (this.legacy && placement.runner === this.legacy.id)
      return this.legacy.repoTool === true;
    const approval = this.enrollment?.repoTool;
    if (approval === true) return true;
    return (
      Array.isArray(approval) &&
      (approval.includes(placement.runner) ||
        approval.includes(`${placement.runner}/${placement.workspace}`))
    );
  }

  /**
   * Whether an agent placed here may still use its MCP credential: an
   * active (enrolled, unrevoked) registration, online or offline. A legacy
   * placement needs a currently non-empty approval file and a configured
   * workspace. Revoked and unknown runners are refused.
   */
  permitsAgentMcp(placement: Placement) {
    if (this.legacy && placement.runner === this.legacy.id) {
      try {
        return (
          this.legacy.workspaces.includes(placement.workspace) &&
          readFileSync(this.legacy.approval, "utf8").trim().length > 0
        );
      } catch {
        return false;
      }
    }
    return Boolean(this.registrationById(placement.runner));
  }

  private registrationById(id: string) {
    for (const registration of this.enrolled.values())
      if (registration.id === id) return registration;
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
        caPem: authority.ca.cert,
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
    // Bun can mark a resumed TLS session authorized even when the client
    // never presented a certificate. Only certificate peers use runner RPC.
    if (socket.authorized && socket.getPeerCertificate()?.fingerprint256) {
      const gate = this.gateFor(socket, kind);
      return gate ? this.attachPeer(socket, gate) : socket.destroy();
    }
    // Unauthenticated peers may pair once or reach the scoped MCP proxy.
    if (this.unauthenticated >= MAX_UNAUTHENTICATED) return socket.destroy();
    this.unauthenticated++;
    let deadline: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => socket.destroy(),
      UNAUTHENTICATED_TIMEOUT
    );
    const release = () => {
      if (deadline === undefined) return;
      socket.removeListener("close", release);
      clearTimeout(deadline);
      deadline = undefined;
      this.unauthenticated--;
    };
    socket.once("close", release);
    let prefix = "";
    const classify = (chunk: Buffer) => {
      if (!prefix && chunk[0] === 0x7b && kind === "enrolled") {
        socket.off("data", classify);
        socket.pause();
        socket.unshift(chunk);
        this.pair(socket);
        socket.resume();
        return;
      }
      // Inspect at most seven method letters, a space and a slash. Keep only
      // a prefix that could become valid, with the original deadline running.
      const candidate = prefix + chunk.toString("latin1", 0, 9 - prefix.length);
      if (/^[A-Z]{3,7} \//.test(candidate)) {
        socket.off("data", classify);
        const head = prefix
          ? Buffer.concat([Buffer.from(prefix, "latin1"), chunk])
          : chunk;
        void this.relay(socket, head, release);
      } else if (/^(?:[A-Z]{1,7}|[A-Z]{3,7} )$/.test(candidate)) {
        prefix = candidate;
      } else {
        socket.destroy();
      }
    };
    socket.on("data", classify);
  }

  /**
   * Hand an HTTP connection to the loopback proxy server, which checks every
   * request on it. Piping (rather than emitting the TLS socket into an
   * http.Server) works the same under Node and Bun.
   */
  private async relay(socket: TLSSocket, head: Buffer, release: () => void) {
    if (this.activeHttpRelays >= this.maxHttpRelays) {
      socket.destroy();
      return;
    }
    this.activeHttpRelays++;
    const started = performance.now();
    const relay: { releaseHandshake?: () => void; requestsServed: number } = {
      releaseHandshake: release,
      requestsServed: 0,
    };
    let closedBy: "client" | "proxy" | undefined;
    socket.once("end", () => (closedBy ??= "client"));
    socket.once("error", () => (closedBy ??= "client"));
    socket.once("close", () => {
      this.activeHttpRelays--;
      this.logger?.debug(
        {
          ageMs: Math.round(performance.now() - started),
          requestsServed: relay.requestsServed,
          closedBy: closedBy ?? "proxy",
        },
        "Runner HTTP relay closed"
      );
    });
    socket.pause();
    try {
      const port = await this.ensureProxy();
      if (socket.destroyed) return;
      const upstream = connectTcp(port, "127.0.0.1");
      upstream.once("end", () => (closedBy ??= "proxy"));
      upstream.on("error", () => {
        closedBy ??= "proxy";
        socket.destroy();
      });
      socket.on("close", () => upstream.destroy());
      upstream.on("close", () => {
        if (!upstream.readableEnded && !socket.destroyed) {
          closedBy ??= "proxy";
          socket.destroy();
        }
      });
      upstream.once("connect", () => {
        const relayPort = upstream.localPort!;
        this.proxyRelays.set(relayPort, relay);
        upstream.once("close", () => this.proxyRelays.delete(relayPort));
        upstream.write(head);
        socket.pipe(upstream).pipe(socket);
        socket.resume();
      });
    } catch {
      socket.destroy();
    }
  }

  private readonly proxyIdleTimeout = PROXY_KEEP_ALIVE_TIMEOUT;
  private readonly proxyRelays = new Map<
    number,
    { releaseHandshake?: () => void; requestsServed: number }
  >();
  private readonly proxyRequests = new WeakMap<
    Socket,
    { pending: number; idleTimer?: ReturnType<typeof setTimeout> }
  >();

  private trackProxyRequest(socket: Socket, response: http.ServerResponse) {
    let entry = this.proxyRequests.get(socket);
    if (!entry) {
      const state: {
        pending: number;
        idleTimer?: ReturnType<typeof setTimeout>;
      } = { pending: 0 };
      socket.once("close", () => clearTimeout(state.idleTimer));
      this.proxyRequests.set(socket, state);
      entry = state;
    }
    clearTimeout(entry.idleTimer);
    entry.pending++;
    const state = entry;
    response.once("finish", () => {
      if (--state.pending === 0)
        state.idleTimer = setTimeout(
          () => socket.end(),
          this.proxyIdleTimeout
        ).unref();
    });
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
        key: legacy.id,
        approved: () => this.legacyApproved(socket),
        allows: (workspace) => legacy.workspaces.includes(workspace),
      };
    }
    const fingerprint = socket.getPeerCertificate().fingerprint256;
    const registration = this.enrolled.get(fingerprint);
    if (!registration) return undefined;
    const registry = this.enrollment!.registry;
    return {
      key: registration.id,
      registrationId: registration.id,
      approved: () => this.enrolled.get(fingerprint)?.id === registration.id,
      allows: () => true,
      ready: (workspaces, managedWorkspace) => {
        registration.workspaces = workspaces;
        registration.managedWorkspace = managedWorkspace;
        void registry
          .connected(registration.id, workspaces, managedWorkspace)
          .catch(() => {});
      },
    };
  }

  private attachPeer(socket: TLSSocket, gate: Gate) {
    socket.setKeepAlive(true, 30_000);
    const deadline = setTimeout(() => socket.destroy(), 5000);
    let peer: Peer | undefined;
    socket.on("close", () => {
      clearTimeout(deadline);
      if (!peer) return;
      if (this.peers.get(gate.key) === peer) {
        this.peers.delete(gate.key);
        for (const notify of this.connectionListeners) notify(gate.key);
      }
      peer.connection.close();
      if (gate.registrationId)
        void this.enrollment?.registry
          .seen(gate.registrationId)
          .catch(() => {});
    });
    const send = wireFrames<RunnerFrame, ServiceFrame>(socket, (frame) => {
      if (!gate.approved()) return socket.destroy();
      if (!peer) {
        const ready = parseReadyFrame(frame);
        if (!ready) return socket.destroy();
        clearTimeout(deadline);
        peer = {
          socket,
          reportsHealth: ready.health === true,
          engineManagement: ready.engineManagement === true,
          engineCapabilities: ready.engineCapabilities === true,
          pullRequestStatus: ready.pullRequestStatus === true,
          pullRequestWatch: ready.pullRequestWatch === true,
          pullRequestEvidence: ready.pullRequestEvidence === true,
          repositoryPicker: ready.repositoryPicker === true,
          githubManagement: ready.githubManagement === true,
          checkoutViews: ready.checkoutViews === true,
          sessionCheckout: ready.sessionCheckout === true,
          checkoutRelease: ready.checkoutRelease === true,
          sessionFiles: ready.sessionFiles === true,
          defaultBranchFiles: ready.defaultBranchFiles === true,
          checkoutMetadata: ready.checkoutMetadata === true,
          checkoutCommands: ready.checkoutCommands === true,
          terminals: ready.terminals === true,
          checkoutInspection: ready.checkoutInspection === true,
          sharedWorktree: ready.sharedWorktree === true,
          workspacePreparation: ready.workspacePreparation === true,
          connection: new RunnerConnection(send),
          workspaces: new Set(ready.workspaces),
          managedWorkspace: ready.managedWorkspace === true,
          gate,
        };
        // A reconnect replaces a half-open predecessor for the same runner.
        const previous = this.peers.get(gate.key);
        this.peers.set(gate.key, peer);
        previous?.socket.destroy();
        gate.ready?.(ready.workspaces, peer.managedWorkspace);
        for (const notify of this.connectionListeners) notify(gate.key);
        if (peer.reportsHealth) {
          send({
            type: "accept_health",
            ...(peer.engineManagement ? { engineInventory: true } : {}),
          });
        }
        return;
      }
      if (this.peers.get(gate.key) !== peer) return socket.destroy();
      if (frame.type === "health" && peer.reportsHealth) {
        const sample = parseRunnerHealth(frame.sample);
        if (!sample) return socket.destroy();
        const receivedAt = new Date();
        // Bound storage writes from an over-eager peer.
        if (
          peer.health &&
          receivedAt.getTime() - peer.health.receivedAt.getTime() < 1000
        )
          return;
        peer.health = { sample, receivedAt };
        if (gate.registrationId)
          void this.enrollment?.registry
            .recordHealth(gate.registrationId, sample, receivedAt)
            .catch((error) =>
              (this.enrollment?.log ?? console).warn(
                "Could not store runner health",
                error
              )
            );
      } else if (
        frame.type === "engine_inventory" &&
        peer.engineManagement &&
        peer.reportsHealth
      ) {
        const entries = parseEngineInventory(frame.entries);
        if (entries === null) return socket.destroy();
        peer.engines = entries;
      } else if (
        frame.type === "launch_progress" &&
        peer.workspacePreparation
      ) {
        const progress = parseLaunchProgress(frame);
        if (!progress) return socket.destroy();
        peer.connection.receive(progress);
      } else if (
        frame.type === "result" ||
        frame.type === "data" ||
        frame.type === "close"
      )
        peer.connection.receive(frame);
      else socket.destroy();
    });
  }

  private pair(socket: TLSSocket) {
    let used = false;
    const reply = (frame: EnrollmentReply) => {
      try {
        send(frame);
      } catch {
        /* closed */
      }
      socket.end();
    };
    const send = wireFrames<EnrollmentRequest, EnrollmentReply>(
      socket,
      (request) => {
        if (used) return socket.destroy();
        used = true;
        // Public bootstrap: the CA certificate, which runners check against
        // the fingerprint pinned in their pairing command.
        if (request.type === "ca_request" && request.version === 1)
          return reply({
            type: "ca",
            ca: this.authority?.caPem ?? "",
          });
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
          ({ registration, cert, ca, previousFingerprint }) => {
            // A re-key retires the old certificate and its live connection.
            if (previousFingerprint) {
              this.enrolled.delete(previousFingerprint);
              this.peers.get(registration.id)?.socket.destroy();
            }
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
      }
    );
  }

  /**
   * Forward bearer-authenticated session MCP calls, `/ping`, and the two
   * runner-initiated ("connect") bootstrap calls to the local API. The
   * bootstrap calls carry no Dispatch credentials — none exist yet — so
   * they are allow-listed by path and method alone, exactly like `/ping`;
   * this is what lets a clean runner reach them through this listener's own
   * pinned CA even when the ordinary API is loopback-only or plain HTTP.
   */
  private forward(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    onAuthenticated: () => void
  ) {
    const url = request.url ?? "";
    const target = this.api;
    const ping = url === "/ping" && request.method === "GET";
    const connectCreate =
      /^\/api\/(?:v1\/)?runners\/connect$/.test(url) &&
      request.method === "POST";
    const connectPoll =
      /^\/api\/(?:v1\/)?runners\/connect\/conn_[A-Za-z0-9_-]{24}$/.test(url) &&
      request.method === "GET";
    const agentId = /^\/api\/mcp\/(agt_[a-z0-9]+)$/.exec(url)?.[1];
    const job = /^\/api\/mcp\/jobs\/([0-9a-f-]{36})\/(agt_[a-z0-9]+)$/.exec(
      url
    );
    const token = /^Bearer (\S+)$/.exec(
      request.headers.authorization ?? ""
    )?.[1];
    const mcp = Boolean(
      token &&
      ["GET", "POST", "DELETE"].includes(request.method ?? "") &&
      ((agentId && target?.validAgentToken?.(token, agentId)) ||
        (job && target?.validJobToken?.(token, job[1]!, job[2]!)))
    );
    if (mcp) {
      onAuthenticated();
    } else {
      // Public and rejected requests do not need a keep-alive connection.
      response.setHeader("Connection", "close");
      if (connectCreate && !request.complete) {
        // Also bound the body on a previously authenticated keep-alive socket.
        const timeout = setTimeout(
          () => request.destroy(),
          UNAUTHENTICATED_TIMEOUT
        ).unref();
        request.once("end", () => clearTimeout(timeout));
        response.once("close", () => clearTimeout(timeout));
      }
    }
    const allowed = ping || mcp || connectCreate || connectPoll;
    if (!allowed || !target) {
      response.writeHead(allowed ? 503 : 404).end();
      return;
    }
    const host =
      target.host === "0.0.0.0"
        ? "127.0.0.1"
        : target.host === "::"
          ? "::1"
          : target.host;
    // Allow-list: nothing ambient (cookies, forwarding, origin) crosses.
    const headers: http.OutgoingHttpHeaders = {};
    for (const name of [
      "accept",
      "content-type",
      "content-length",
      "transfer-encoding",
      "user-agent",
      "last-event-id",
      "mcp-session-id",
      "mcp-protocol-version",
      ...(mcp ? ["authorization"] : []),
    ])
      if (request.headers[name] !== undefined)
        headers[name] = request.headers[name];
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
        const headers = { ...reply.headers };
        delete headers.connection;
        delete headers["keep-alive"];
        response.writeHead(reply.statusCode ?? 502, headers);
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

  async list(includeCleared = false): Promise<RunnerSummary[]> {
    const runners: RunnerSummary[] = [];
    if (this.legacy) {
      const peer = this.peers.get(this.legacy.id);
      runners.push({
        // Legacy locators keep addressing the configured id.
        id: this.legacy.id,
        name: this.legacy.id,
        engineManagement:
          peer?.gate.approved() === true && peer.engineManagement,
        ...(peer?.gate.approved() &&
          peer.engineCapabilities && { engineCapabilities: true as const }),
        ...(peer?.gate.approved() &&
          peer.repositoryPicker && { repositoryPicker: true }),
        githubManagement:
          peer?.gate.approved() === true && peer.githubManagement,
        ...(peer?.engines ? { engines: peer.engines } : {}),
        ...(peer?.health
          ? {
              health: peer.health.sample,
              healthReceivedAt: peer.health.receivedAt.toISOString(),
            }
          : {}),
        status: peer?.gate.approved() ? "online" : "offline",
        workspaces: peer
          ? [...peer.workspaces].filter((w) =>
              this.legacy!.workspaces.includes(w)
            )
          : [...this.legacy.workspaces],
        ...(peer?.managedWorkspace && peer.gate.allows(MANAGED_WORKSPACE)
          ? { managedWorkspace: true }
          : {}),
      });
    }
    if (!this.enrollment) return runners;
    for (const registration of await this.enrollment.registry.list(
      includeCleared
    )) {
      const peer = this.peers.get(registration.id);
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
        engineManagement: online && peer.engineManagement,
        ...(online &&
          peer.engineCapabilities && { engineCapabilities: true as const }),
        ...(online && peer.repositoryPicker && { repositoryPicker: true }),
        githubManagement: online && peer.githubManagement,
        ...(online && peer.engines ? { engines: peer.engines } : {}),
        ...(online && peer.health
          ? {
              health: peer.health.sample,
              healthReceivedAt: peer.health.receivedAt.toISOString(),
            }
          : registration.health && registration.healthReceivedAt
            ? {
                health: registration.health,
                healthReceivedAt: registration.healthReceivedAt.toISOString(),
              }
            : {}),
        workspaces: online ? [...peer!.workspaces] : registration.workspaces,
        ...((online ? peer!.managedWorkspace : registration.managedWorkspace)
          ? { managedWorkspace: true }
          : {}),
      });
    }
    return runners;
  }

  async createRegistration(name: unknown, hostHint?: string) {
    if (!this.enrollment)
      throw new RunnerRequestError(409, "Runner enrollment is disabled.");
    if (!validRunnerName(name))
      throw new RunnerRequestError(
        400,
        "Runner names are 1-64 characters without control characters or surrounding spaces."
      );
    const host = await this.prepareEndpoint(hostHint);
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

  private async prepareEndpoint(hostHint?: string) {
    const host = this.enrollment!.endpointHost ?? advertisedHost(hostHint);
    if (!validHost(host))
      throw new RunnerRequestError(400, "The runner endpoint host is invalid.");
    await this.ensureListening(host);
    return host;
  }

  /**
   * Renewal and re-keying: a fresh one-time code for an existing
   * registration. Pairing with it replaces the certificate, keeps the id
   * (so agent placements are unchanged), and drops the old connection.
   */
  async reissueRegistration(id: string, hostHint?: string) {
    if (!this.enrollment || this.legacy?.id === id)
      throw new RunnerRequestError(404, "Runner not found.");
    const host = await this.prepareEndpoint(hostHint);
    const issued = await this.enrollment.registry.reissue(id, host);
    if (!issued) throw new RunnerRequestError(404, "Runner not found.");
    return {
      id,
      command: pairingCommand({
        host,
        port: this.port!,
        caFingerprint: this.authority!.caFingerprint,
        code: issued.code,
      }),
      expiresAt: issued.expiresAt.toISOString(),
    };
  }

  async clearRevoked(ids: string[]): Promise<number> {
    return (await this.enrollment?.registry.clearRevoked(ids)) ?? 0;
  }

  /** Revoke a registration and drop its live connection immediately. */
  async revoke(id: string) {
    if (this.legacy?.id === id)
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
  // Runner-initiated ("connect") enrollment
  // ---------------------------------------------------------------------------

  private approveUrl() {
    let origin = this.enrollment?.approvalOrigin;
    if (!origin && this.api) {
      const { host, port, tls } = this.api;
      const webHost =
        host === "0.0.0.0" || host === "::" ? advertisedHost(undefined) : host;
      origin = `${tls ? "https" : "http"}://${formatHost(webHost)}:${port}`;
    }
    return origin ? new URL("/settings/runners", origin).href : undefined;
  }

  async connectCommand(hostHint?: string) {
    if (!this.enrollment)
      throw new RunnerRequestError(409, "Runner enrollment is disabled.");
    const host = await this.prepareEndpoint(hostHint);
    return {
      command: connectCliCommand({
        host,
        port: this.port!,
        caFingerprint: this.authority!.caFingerprint,
      }),
      approveUrl: this.approveUrl(),
    };
  }

  /**
   * `POST /api/runners/connect`: an unauthenticated runner requests pairing.
   * Reached either directly or, for a runner that only has the listener's
   * own pinned CA (see `connectCommand`), proxied through it like `/ping`.
   */
  async createConnectRequest(publicKey: unknown): Promise<ConnectCreated> {
    if (!this.enrollment)
      throw new RunnerRequestError(409, "Runner enrollment is disabled.");
    if (typeof publicKey !== "string" || publicKey.length === 0)
      throw new RunnerRequestError(400, "A public key is required.");
    try {
      const { id, code, expiresAt } =
        await this.enrollment.registry.createConnectRequest(publicKey);
      return {
        id,
        code,
        expiresAt: expiresAt.toISOString(),
        approveUrl: this.approveUrl(),
      };
    } catch (error) {
      if (error instanceof PairingRejected)
        throw new RunnerRequestError(400, error.message);
      throw error;
    }
  }

  /** `GET /api/runners/connect/:id`: the runner's own unauthenticated poll. */
  async pollConnectRequest(id: string): Promise<ConnectPoll> {
    if (!this.enrollment)
      throw new RunnerRequestError(409, "Runner enrollment is disabled.");
    const request = await this.enrollment.registry.pollConnectRequest(id);
    if (!request) return { status: "expired" as const };
    if (request.denied) return { status: "denied" as const };
    if (!request.approved || !request.registrationId || !request.cert)
      return { status: "pending" as const };
    const authority = await this.enrollment.registry.authority();
    if (!authority.port) return { status: "pending" as const };
    const registration = (await this.enrollment.registry.list()).find(
      (entry) => entry.id === request.registrationId
    );
    if (!registration) return { status: "pending" as const };
    return {
      status: "approved" as const,
      id: request.registrationId,
      name: request.name ?? registration.name,
      endpoint: `https://${formatHost(registration.endpointHost)}:${authority.port}`,
      cert: request.cert,
      ca: authority.ca.cert,
    };
  }

  /** The authenticated list for the approval UI. */
  async listConnectRequests() {
    if (!this.enrollment) return [];
    return (await this.enrollment.registry.listConnectRequests()).map(
      (request) => ({
        id: request.id,
        createdAt: request.createdAt.toISOString(),
        expiresAt: request.codeExpiresAt.toISOString(),
      })
    );
  }

  /** `POST /api/runners/connect/:id/approve`: the authenticated operator. */
  async approveConnectRequest(
    id: string,
    code: unknown,
    name: unknown,
    hostHint?: string
  ) {
    if (!this.enrollment)
      throw new RunnerRequestError(409, "Runner enrollment is disabled.");
    if (typeof code !== "string" || code.length === 0)
      throw new RunnerRequestError(400, "A code is required.");
    if (!validRunnerName(name))
      throw new RunnerRequestError(
        400,
        "Runner names are 1-64 characters without control characters or surrounding spaces."
      );
    const host = await this.prepareEndpoint(hostHint);
    try {
      const approved = await this.enrollment.registry.approveConnectRequest(
        id,
        code,
        name,
        host
      );
      // Mirror the legacy pairing frame handler: a runner dialing the
      // listener immediately after approval must already resolve to a gate.
      this.enrolled.set(
        approved.registration.fingerprint!,
        approved.registration
      );
      return { id: approved.registration.id, name: approved.registration.name };
    } catch (error) {
      if (error instanceof RunnerNameTaken)
        throw new RunnerRequestError(409, error.message);
      if (error instanceof ConnectRequestInvalid)
        throw new RunnerRequestError(404, error.message);
      if (error instanceof PairingRejected)
        throw new RunnerRequestError(400, error.message);
      throw error;
    }
  }

  /** `DELETE /api/runners/connect/:id`: deny or cancel a pending request. */
  async denyConnectRequest(id: string) {
    if (!this.enrollment)
      throw new RunnerRequestError(409, "Runner enrollment is disabled.");
    const denied = await this.enrollment.registry.denyConnectRequest(id);
    if (!denied)
      throw new RunnerRequestError(404, "Connect request not found.");
  }

  // ---------------------------------------------------------------------------
  // Agent operations
  // ---------------------------------------------------------------------------

  isManagedWorkspace(placement: Placement) {
    return (
      placement.workspace === MANAGED_WORKSPACE &&
      this.peers.get(placement.runner)?.managedWorkspace === true &&
      this.available(placement)
    );
  }

  /** The runner's last pushed, validated engine inventory, if any. */
  engineInventorySnapshot(
    runnerId: string
  ): EngineInventoryEntry[] | undefined {
    const peer = this.peers.get(runnerId);
    return peer?.gate.approved() ? peer.engines : undefined;
  }

  requestSession(
    placement: Placement,
    operation: SessionOperation,
    onProgress?: (progress: LaunchProgress) => void,
    signal?: AbortSignal
  ) {
    return this.request(
      placement,
      { ...operation, workspace: placement.workspace },
      operation.kind === "attach" ||
        operation.kind === "watchCheckout" ||
        operation.kind === "openTerminal",
      onProgress,
      signal
    );
  }

  async requestRunner(runnerId: string, operation: RunnerOperation) {
    const peer = this.peers.get(runnerId);
    if (!peer?.gate.approved())
      throw new RunnerUnavailable("The runner is disconnected or unavailable.");
    if (
      operation.kind === "engine"
        ? !peer.engineManagement
        : !peer.githubManagement
    )
      throw new RunnerCapabilityUnavailable(
        operation.kind === "engine"
          ? "This runner does not support engine management."
          : "Update the runner to manage its GitHub account."
      );

    if (
      operation.kind === "github" &&
      operation.operation.type === "pullRequestStatus" &&
      !peer.pullRequestStatus
    )
      throw new RunnerCapabilityUnavailable(
        "Update the runner to read pull request status."
      );

    if (
      operation.kind === "github" &&
      (operation.operation.type === "pullRequestDetails" ||
        operation.operation.type === "pullRequestDiff" ||
        (operation.operation.type === "pullRequestStatus" &&
          operation.operation.withCredentialContext)) &&
      !peer.pullRequestEvidence
    )
      throw new RunnerCapabilityUnavailable(
        "Update the runner to read pull request evidence."
      );

    if (
      operation.kind === "github" &&
      (operation.operation.type === "watchPullRequests" ||
        (operation.operation.type === "pullRequestStatus" &&
          operation.operation.refreshWatch)) &&
      !peer.pullRequestWatch
    )
      throw new RunnerCapabilityUnavailable(
        "Runner does not support PR watches."
      );

    if (
      operation.kind === "engine" &&
      isEngineCapabilityOperation(operation.operation) &&
      !peer.engineCapabilities
    ) {
      throw new RunnerCapabilityUnavailable(
        "Update the runner to read engine capabilities."
      );
    }

    if (
      operation.kind === "github" &&
      (operation.operation.type === "repositorySearch" ||
        operation.operation.type === "repositoryBranches") &&
      !peer.repositoryPicker
    ) {
      throw new RunnerCapabilityUnavailable(
        "Update the runner to browse your repositories."
      );
    }

    // V1 requires a routable workspace and an id even for a runner-wide operation.
    for (const workspace of peer.workspaces) {
      if (peer.gate.allows(workspace)) {
        const result = await this.request(
          { runner: runnerId, workspace },
          { ...operation, agentId: `@${operation.kind}`, workspace },
          operation.kind === "engine" ||
            operation.operation.type === "watchPullRequests"
        );
        if (this.peers.get(runnerId) !== peer || !peer.gate.approved()) {
          result.channel?.destroy();
          throw new RunnerUnavailable("The runner connection changed.");
        }
        return result;
      }
    }
    throw new RunnerUnavailable("The runner has no available workspace.");
  }

  private async requestGitHub(
    runnerId: string,
    operation: GitHubOperation
  ): Promise<unknown> {
    const peer = this.peers.get(runnerId);
    const { value } = await this.requestRunner(runnerId, {
      kind: "github",
      operation,
    });
    if (this.peers.get(runnerId) !== peer || !peer?.gate.approved())
      throw new RunnerUnavailable("The runner connection changed.");
    if (typeof value !== "string") throw new Error("Invalid GitHub reply.");
    return JSON.parse(value);
  }

  async githubAccount(
    runnerId: string,
    type: "status" | "login" | "cancel" | "logout"
  ): Promise<GitHubStatus> {
    try {
      const status = parseGitHubStatus(
        await this.requestGitHub(runnerId, { type })
      );
      if (status.status === "failed")
        return {
          ...status,
          message:
            status.message ??
            "The runner reported a GitHub failure without a more specific reason.",
        };
      if (status.status === "unavailable")
        return {
          ...status,
          message:
            status.message ??
            "Could not verify the GitHub account. Check the runner’s connection to github.com and retry.",
        };
      return status;
    } catch (error) {
      if (
        error instanceof RunnerCapabilityUnavailable ||
        error instanceof RunnerUnavailable
      )
        return { status: "unavailable", message: error.message };
      return {
        status: "unavailable",
        message: "The runner could not report its GitHub account.",
      };
    }
  }

  async listGitHubBranches(runnerId: string, owner: string, repo: string) {
    const response = await this.requestGitHub(runnerId, {
      type: "repositoryBranches",
      owner,
      repo,
    });
    if (
      !response ||
      typeof response !== "object" ||
      !("branches" in response) ||
      !Array.isArray(response.branches) ||
      !response.branches.every(validBranch)
    ) {
      throw new Error("Invalid GitHub branches reply.");
    }
    // Peers older than the default-branch lookup reply with names only.
    const named =
      "defaultBranch" in response && validBranch(response.defaultBranch)
        ? response.defaultBranch
        : undefined;
    return {
      branches: response.branches as string[],
      ...(named && { defaultBranch: named }),
    };
  }

  async searchGitHubRepositories(runnerId: string, query: string) {
    const response = await this.requestGitHub(runnerId, {
      type: "repositorySearch",
      query,
    });
    if (
      !response ||
      typeof response !== "object" ||
      !("repositories" in response)
    )
      throw new Error("Invalid GitHub repository reply.");
    return githubRepositoryResults(response.repositories);
  }

  canWatchPullRequests(runnerId: string) {
    const peer = this.peers.get(runnerId);
    return (
      peer?.gate.approved() === true &&
      peer.githubManagement &&
      peer.pullRequestWatch
    );
  }

  async watchPullRequests(
    runnerId: string,
    urls: string[],
    event: (value: GitHubPullRequestWatchEvent) => void,
    closed: () => void
  ) {
    const peer = this.peers.get(runnerId);
    const active = () =>
      this.peers.get(runnerId) === peer && peer?.gate.approved();
    const { value, channel } = await this.requestRunner(runnerId, {
      kind: "github",
      operation: {
        type: "watchPullRequests",
        targets: urls
          .map(githubPullRequestTarget)
          .filter(isGitHubPullRequestTarget),
      },
    });
    if (!active() || !channel || value !== true) {
      channel?.destroy();
      throw new RunnerUnavailable("Runner PR watch is unavailable.");
    }
    // A runner sends one complete JSON line per channel data frame.
    channel.on("data", (chunk: Buffer) => {
      if (!active() || channel.destroyed) return;
      try {
        if (chunk.length > MAX_PULL_REQUEST_WATCH_EVENT_BYTES)
          throw new Error();
        const observation = parseGitHubPullRequestWatchEvent(
          JSON.parse(chunk.toString())
        );
        if (!observation) throw new Error();
        event(observation);
      } catch {
        channel.destroy();
      }
    });
    channel.once("close", closed);
    return () => channel.destroy();
  }

  async readPullRequest(
    runnerId: string,
    url: string,
    title: string,
    refreshWatch = false
  ) {
    const canonical = githubPullRequestUrl(url);
    if (!canonical) return { url, title, status: "Unavailable" as const };
    const [, owner, repo, , number] = new URL(canonical).pathname.split("/");
    const response = await this.requestGitHub(runnerId, {
      type: "pullRequestStatus",
      owner,
      repo,
      number: Number(number),
      ...(refreshWatch &&
        this.canWatchPullRequests(runnerId) && { refreshWatch: true }),
      ...(this.peers.get(runnerId)?.pullRequestEvidence && {
        withCredentialContext: true,
      }),
    });
    if (!isGitHubPullRequestObservation(response))
      throw new Error("Invalid runner pull request observation.");
    return projectPullRequest(canonical, title, response);
  }

  async readPullRequestDetails(runnerId: string, url: string) {
    const target = githubPullRequestTarget(url);
    if (!target) return null;
    const value = await this.requestGitHub(runnerId, {
      ...target,
      type: "pullRequestDetails",
    });
    return isGitHubPullRequestDetails(value) && value.number === target.number
      ? value
      : null;
  }

  async readPullRequestDiff(
    runnerId: string,
    url: string,
    base: string,
    head: string,
    credentialContext: string
  ) {
    const target = githubPullRequestTarget(url);
    if (!target) return null;
    const value = await this.requestGitHub(runnerId, {
      ...target,
      type: "pullRequestDiff",
      base,
      head,
      credentialContext,
    });
    return isGitHubPullRequestDiff(value) ? value : null;
  }

  async lookupGitHubPullRequestHead(
    runnerId: string,
    owner: string,
    repo: string,
    number: number
  ) {
    return githubPullRequestHead(
      await this.requestGitHub(runnerId, {
        type: "pullRequestHead",
        owner,
        repo,
        number,
      })
    );
  }

  supportsSessionFiles(placement: Placement) {
    return (
      this.available(placement) &&
      this.peers.get(placement.runner)?.sessionFiles === true
    );
  }

  supportsSessionCheckout(placement: Placement) {
    return (
      this.available(placement) &&
      this.peers.get(placement.runner)?.sessionCheckout === true
    );
  }

  supportsSharedWorktree(placement: Placement) {
    return (
      this.available(placement) &&
      this.peers.get(placement.runner)?.sharedWorktree === true
    );
  }

  available(placement: Placement) {
    const peer = this.peers.get(placement.runner);
    return Boolean(
      peer &&
      peer.gate.approved() &&
      peer.gate.allows(placement.workspace) &&
      peer.workspaces.has(placement.workspace)
    );
  }

  async request(
    placement: Placement,
    command: Command,
    open = false,
    onProgress?: (progress: LaunchProgress) => void,
    signal?: AbortSignal
  ) {
    const peer = this.peers.get(placement.runner);
    if (
      !this.registrationById(placement.runner) &&
      placement.runner !== this.legacy?.id &&
      (await this.enrollment?.registry.isRevoked(placement.runner))
    ) {
      throw new RunnerRevoked();
    }
    if (
      !peer ||
      !this.available(placement) ||
      command.workspace !== placement.workspace
    ) {
      throw new RunnerUnavailable(
        "The enrolled runner is disconnected or the workspace is unavailable."
      );
    }
    if (
      (command.kind === "viewCheckout" || command.kind === "watchCheckout") &&
      !peer.checkoutViews
    )
      throw new RunnerCapabilityUnavailable(
        "Update this runner to open Files and Changes."
      );
    const checkout =
      command.kind === "launch"
        ? command.launch.repository?.checkout
        : undefined;
    if (
      (command.kind === "sessionCheckout" ||
        checkout?.kind === "default" ||
        (checkout?.kind === "branch" && checkout.allowDefault)) &&
      !peer.sessionCheckout
    )
      throw new RunnerCapabilityUnavailable(
        "Update the runner to use these checkout options."
      );
    if (command.kind === "openTerminal" && !peer.terminals)
      throw new RunnerCapabilityUnavailable(
        "Update this runner to open a terminal."
      );
    if (command.kind === "checkoutCommand" && !peer.checkoutCommands)
      throw new RunnerCapabilityUnavailable(
        "Update the runner to execute checkout commands."
      );
    if (command.kind === "sessionFile" && !peer.sessionFiles)
      throw new RunnerCapabilityUnavailable(
        "Update the runner to transfer session files."
      );
    if (command.kind === "checkoutRelease" && !peer.checkoutRelease)
      throw new RunnerCapabilityUnavailable(
        "Update the runner to inspect and release a session checkout."
      );
    if (
      command.kind === "inspectCheckout" &&
      command.query.kind === "defaultBranchFiles" &&
      !peer.defaultBranchFiles
    )
      throw new RunnerCapabilityUnavailable(
        "Update the runner to read default-branch files."
      );
    if (
      command.kind === "inspectCheckout" &&
      (command.query.kind === "roots" || command.query.kind === "listFiles") &&
      !peer.checkoutMetadata
    )
      throw new RunnerCapabilityUnavailable(
        "Update the runner to discover checkout metadata."
      );
    if (command.kind === "inspectCheckout" && !peer.checkoutInspection)
      throw new RunnerCapabilityUnavailable(
        "Update the runner to inspect a session checkout."
      );
    if (
      command.kind === "launch" &&
      command.launch.useWorktreeOf &&
      !peer.sharedWorktree
    )
      throw new RunnerCapabilityUnavailable(
        "Update the runner to launch a reviewer in an existing checkout."
      );
    if (command.kind === "launch" && peer.workspacePreparation && onProgress)
      command = {
        ...command,
        launch: { ...command.launch, prepareWorkspace: true },
      };
    if (
      command.kind === "launch" &&
      command.launch.prepareWorkspace &&
      !peer.workspacePreparation
    )
      throw new RunnerCapabilityUnavailable(
        "Update the runner to prepare session workspaces."
      );
    if (command.kind === "sessionFile") {
      // A single file can occupy most of the transport's write buffer.
      const transfer = (peer.sessionFileTail ?? Promise.resolve())
        .catch(() => {})
        .then(() => peer.connection.request(command));
      peer.sessionFileTail = transfer;
      try {
        return await transfer;
      } finally {
        if (peer.sessionFileTail === transfer) peer.sessionFileTail = undefined;
      }
    }
    return peer.connection.request(command, {
      openChannel: open,
      onProgress,
      signal,
    });
  }

  close() {
    if (this.legacy) unwatchFile(this.legacy.approval, this.recheckLegacy);
    for (const socket of this.sockets) socket.destroy();
    this.legacyListener?.close();
    this.listener?.close();
    if (this.proxyPort) this.proxy.close();
  }
}
