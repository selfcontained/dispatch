import {
  runnerIdFromWire,
  type RunnerDescription,
  type Req,
} from "@dispatch/runner-protocol/contract";
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
import { Writable } from "node:stream";
import { createServer, type Server, type TLSSocket } from "node:tls";
import {
  receiveFile,
  receiveCheckoutExec,
  openTerminalStream,
  RunnerConnection,
  RunnerUnavailable,
} from "../../runners/enrolled/v1-framing.js";
export {
  RunnerUnavailable,
  RunnerHostGone,
  RunnerUpdateFenced,
  RunnerAcknowledgementLost,
} from "../../runners/enrolled/v1-framing.js";
import type { Pool } from "pg";
import {
  FlowStreams,
  type StreamFrame,
} from "../../runners/enrolled/v1-framing.js";
import type { FastifyBaseLogger } from "fastify";
import {
  parseRunnerHealth,
  type RunnerHealth,
  parseReadyFrame,
  type ReadyFrame,
  RUNNER_WIRE_VERSION,
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
  endsUpdateAttempt,
  parseUpdateServiceFrame,
  parseUpdateStatus,
  type RunnerUpdateCancelReason,
  type RunnerUpdateTarget,
  type SelfUpdateAdvert,
  type UpdateServiceFrame,
  type UpdateStatusFrame,
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
import { resolveRunnerUpdatePath } from "./update-artifact-path.js";
import { publicKeyPin } from "./x509.js";

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
  log?: Pick<Console, "info" | "warn">;
};

export type RunnerStatus = "pending" | "online" | "offline" | "revoked";
export type RunnerSummary = {
  id: string;
  name: string;
  status: RunnerStatus;
  automaticUpdates?: boolean;
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

/**
 * A resume opened another session and its host was stopped. The host saved
 * that session, so launching again would be refused the same way.
 */
export class RunnerResumeRefused extends Error {}

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

/** One runner status frame and the connection that carried it. */
export type RunnerUpdateEvent = {
  runnerId: string;
  /** Changes on every accepted connection for the runner. */
  epoch: number;
  status: UpdateStatusFrame;
};

type Peer = {
  socket: TLSSocket;
  connection: RunnerConnection;
  streams?: FlowStreams;
  filesGetStream: boolean;
  /** The raw frame sender for this connection. */
  send: (frame: ServiceFrame) => void;
  epoch: number;
  /** Advertised self-update support; update frames go only to such a peer. */
  selfUpdate?: SelfUpdateAdvert;
  workspaces: Set<string>;
  managedWorkspace: boolean;
  gate: Gate;
  health?: { sample: RunnerHealth; receivedAt: Date };
  healthStoredAt?: number;
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
  checkoutExecStream: boolean;
  terminals: boolean;
  terminalOpenStream: boolean;
  defaultBranchFiles: boolean;
  sessionCheckout: boolean;
  checkoutRelease: boolean;
  sessionFiles: boolean;
  sessionFileTail?: Promise<unknown>;
  checkoutViews: boolean;
  sharedWorktree: boolean;
  workspacePreparation: boolean;
  /** Reconciles a repeated `launch.launchId` instead of running it again. */
  launchReconcile: boolean;
  /** Last pushed, validated engine inventory; absent until the runner first reports one. */
  engines?: EngineInventoryEntry[];
};

const MAX_UNAUTHENTICATED = 64;
const MAX_HTTP_RELAYS = 256;
const UNAUTHENTICATED_TIMEOUT = 10_000;
/** A runner release download may outlast the handshake bound on a slow link. */
const ARTIFACT_DOWNLOAD_TIMEOUT = 30 * 60_000;
const ARTIFACT_IDLE_TIMEOUT = 60_000;
const MAX_ARTIFACT_RELAYS = 8;
/** Where the web origin serves the runner install script. */
export const RUNNER_INSTALL_PATH = "/api/v1/runner-artifacts/install";
/** The runner listener's short alias for that script. */
export const RUNNER_LISTENER_INSTALL_PATH = "/install";
/** Set only by the listener's relay: the origin its client connected to. */
export const RUNNER_LISTENER_ORIGIN_HEADER = "x-dispatch-runner-listener";
const RUNNER_ARTIFACT_PATH =
  /^\/api\/v1\/runner-artifacts\/[a-f0-9]{7,40}\/(?:descriptor-linux-(?:x64|arm64)\.json|install-dispatch-runner-linux-(?:x64|arm64)\.sh(?:\.sigstore\.json)?|dispatch-runner-linux-(?:x64|arm64)\.tar\.gz(?:\.sigstore\.json)?)$/;
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

type ProxyRelay = {
  releaseHandshake?: () => void;
  reserveArtifact: (response: http.ServerResponse) => boolean;
  startDownload: () => void;
  hasArtifact: () => boolean;
  requestsServed: number;
};

export class RemoteRunnerService {
  /** Connected runners by placement name; each is an independent peer. */
  private readonly connectionListeners = new Set<(runnerId: string) => void>();
  onConnectionChange(listener: (runnerId: string) => void) {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }
  private readonly revoking = new Set<string>();
  private readonly peers = new Map<string, Peer>();
  /** What each runner's latest approved connection advertised; kept after
   * it disconnects, for admitting launches a runner update will hold. */
  private readonly lastSeen = new Map<
    string,
    Pick<
      Peer,
      | "gate"
      | "workspaces"
      | "managedWorkspace"
      | "sessionFiles"
      | "sharedWorktree"
      | "engines"
      | "epoch"
    > & { ready: ReadyFrame; build?: RunnerDescription["build"] }
  >();
  private peerEpoch = 0;
  private readonly updateListeners = new Set<
    (event: RunnerUpdateEvent) => void
  >();
  /** Enrolled, unrevoked registrations by client certificate fingerprint. */
  private readonly enrolled = new Map<string, Registration>();
  private readonly legacySockets = new Set<TLSSocket>();
  private readonly sockets = new Set<TLSSocket>();
  private unauthenticated = 0;
  private activeHttpRelays = 0;
  private activeArtifactRelays = 0;
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
        this.forward(
          request,
          response,
          () => {
            relay?.releaseHandshake?.();
            if (relay) relay.releaseHandshake = undefined;
          },
          relay
        );
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
      this.handshakeTimeout
    );
    let hasSlot = true;
    const releaseSlot = () => {
      if (!hasSlot) return;
      hasSlot = false;
      this.unauthenticated--;
    };
    const clearDeadline = () => {
      clearTimeout(deadline);
      deadline = undefined;
    };
    const release = () => {
      releaseSlot();
      clearDeadline();
    };
    const setDeadline = (ms: number) => {
      clearDeadline();
      deadline = setTimeout(() => socket.destroy(), ms);
    };
    socket.once("close", releaseSlot);
    socket.once("close", clearDeadline);
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
        void this.relay(socket, head, {
          release,
          releaseSlot,
          clearDeadline,
          setDeadline,
        });
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
  private async relay(
    socket: TLSSocket,
    head: Buffer,
    handshake: {
      release: () => void;
      releaseSlot: () => void;
      clearDeadline: () => void;
      setDeadline: (ms: number) => void;
    }
  ) {
    if (this.activeHttpRelays >= this.maxHttpRelays) {
      socket.destroy();
      return;
    }
    this.activeHttpRelays++;
    const started = performance.now();
    let servingArtifact = false;
    let reservedArtifact = false;
    let downloadIdle: ReturnType<typeof setTimeout> | undefined;
    let downloadCap: ReturnType<typeof setTimeout> | undefined;
    const clearDownload = () => {
      clearTimeout(downloadIdle);
      clearTimeout(downloadCap);
      downloadIdle = downloadCap = undefined;
    };
    const resetDownloadIdle = () => {
      clearTimeout(downloadIdle);
      downloadIdle = setTimeout(
        () => socket.destroy(),
        this.artifactIdleTimeout
      );
    };
    const relay: ProxyRelay = {
      releaseHandshake: handshake.release,
      reserveArtifact: (response) => {
        // An artifact request, including a refusal, no longer needs a
        // pairing or scoped MCP handshake slot.
        servingArtifact = true;
        handshake.releaseSlot();
        if (!relay.releaseHandshake)
          handshake.setDeadline(this.handshakeTimeout);
        if (this.activeArtifactRelays >= MAX_ARTIFACT_RELAYS) return false;
        reservedArtifact = true;
        this.activeArtifactRelays++;
        const proxySocket = response.socket;
        response.once("finish", () => {
          if (!downloadCap) handshake.setDeadline(this.handshakeTimeout);
          // Deliver the loopback FIN after these bytes so the TLS writer can
          // end the long deadline when the complete response reaches it.
          proxySocket?.end();
        });
        return true;
      },
      hasArtifact: () => servingArtifact,
      startDownload: () => {
        handshake.clearDeadline();
        downloadCap = setTimeout(
          () => socket.destroy(),
          this.artifactDownloadTimeout
        );
        resetDownloadIdle();
      },
      requestsServed: 0,
    };
    let closedBy: "client" | "proxy" | undefined;
    socket.once("end", () => (closedBy ??= "client"));
    socket.once("error", () => (closedBy ??= "client"));
    socket.once("close", () => {
      this.activeHttpRelays--;
      if (reservedArtifact) this.activeArtifactRelays--;
      clearDownload();
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
        // Track writes to the client TLS stream, beyond the loopback proxy's
        // buffers. Incoming bytes cannot renew a stalled download.
        const client = new Writable({
          write(chunk, _encoding, done) {
            socket.write(chunk, (error) => {
              if (!error && downloadIdle) resetDownloadIdle();
              done(error);
            });
          },
          final: (done) => {
            if (downloadCap) {
              clearDownload();
              handshake.setDeadline(this.handshakeTimeout);
            }
            socket.end(done);
          },
        });
        client.on("error", () => socket.destroy());
        socket.once("close", () => client.destroy());
        socket.pipe(upstream).pipe(client);
        socket.resume();
      });
    } catch {
      socket.destroy();
    }
  }

  private readonly proxyIdleTimeout = PROXY_KEEP_ALIVE_TIMEOUT;
  private readonly handshakeTimeout = UNAUTHENTICATED_TIMEOUT;
  private readonly artifactDownloadTimeout = ARTIFACT_DOWNLOAD_TIMEOUT;
  private readonly artifactIdleTimeout = ARTIFACT_IDLE_TIMEOUT;
  private readonly proxyRelays = new Map<number, ProxyRelay>();
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
    const send = wireFrames<
      RunnerFrame | StreamFrame,
      ServiceFrame | StreamFrame
    >(socket, (frame) => {
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
          filesGetStream: ready.filesGetStream === true,
          defaultBranchFiles: ready.defaultBranchFiles === true,
          checkoutMetadata: ready.checkoutMetadata === true,
          checkoutCommands: ready.checkoutCommands === true,
          checkoutExecStream: ready.checkoutExecStream === true,
          terminals: ready.terminals === true,
          terminalOpenStream: ready.terminalOpenStream === true,
          checkoutInspection: ready.checkoutInspection === true,
          sharedWorktree: ready.sharedWorktree === true,
          workspacePreparation: ready.workspacePreparation === true,
          launchReconcile: ready.launchReconcile === true,
          connection: new RunnerConnection(send),
          ...(ready.streamCredit && { streams: new FlowStreams(socket, send) }),
          send,
          epoch: ++this.peerEpoch,
          ...(ready.selfUpdate && { selfUpdate: ready.selfUpdate }),
          workspaces: new Set(ready.workspaces),
          managedWorkspace: ready.managedWorkspace === true,
          gate,
        };
        // A reconnect replaces a half-open predecessor for the same runner.
        const previous = this.peers.get(gate.key);
        this.peers.set(gate.key, peer);
        this.lastSeen.set(gate.key, {
          gate,
          ready,
          epoch: peer.epoch,
          build: ready.selfUpdate,
          workspaces: peer.workspaces,
          managedWorkspace: peer.managedWorkspace,
          sessionFiles: peer.sessionFiles,
          sharedWorktree: peer.sharedWorktree,
          engines: this.lastSeen.get(gate.key)?.engines,
        });
        previous?.socket.destroy();
        if (peer.streams) {
          send({
            type: "stream",
            action: "accept",
            ...(peer.checkoutExecStream && { checkoutExecStream: true }),
            ...(peer.terminalOpenStream && { terminalOpenStream: true }),
          });
          peer.streams.enable();
        }
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
      if (peer.streams?.handle(frame)) return;
      if (frame.type === "health" && peer.reportsHealth) {
        const sample = parseRunnerHealth(frame.sample);
        if (!sample) return socket.destroy();
        const receivedAt = new Date();
        // The latest sample is served: an update's commit can follow the
        // connection's first one within a second.
        peer.health = { sample, receivedAt };
        this.lastSeen.get(gate.key)!.build = {
          version: sample.version,
          revision: sample.revision,
        };
        // Bound storage writes from an over-eager peer.
        if (
          peer.healthStoredAt !== undefined &&
          receivedAt.getTime() - peer.healthStoredAt < 1000
        )
          return;
        peer.healthStoredAt = receivedAt.getTime();
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
        this.lastSeen.get(gate.key)!.engines = entries;
      } else if (
        frame.type === "launch_progress" &&
        peer.workspacePreparation
      ) {
        const progress = parseLaunchProgress(frame);
        if (!progress) return socket.destroy();
        peer.connection.receive(progress);
      } else if (frame.type === "update_status" && peer.selfUpdate) {
        const status = parseUpdateStatus(frame);
        if (!status) return socket.destroy();
        // The ready advert is otherwise cached for the whole connection.
        if (status.fenceCleared) {
          const { fenceUnreadable: _, ...advert } = peer.selfUpdate;
          peer.selfUpdate = advert;
        }
        if (
          peer.selfUpdate.pendingAttemptId === status.attemptId &&
          endsUpdateAttempt(status)
        ) {
          const { pendingAttemptId: _, ...advert } = peer.selfUpdate;
          peer.selfUpdate = advert;
        }
        const event = { runnerId: gate.key, epoch: peer.epoch, status };
        for (const listener of this.updateListeners) {
          try {
            listener(event);
          } catch (error) {
            (this.enrollment?.log ?? console).warn(
              "Runner update listener failed",
              error
            );
          }
        }
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
   * Forward bearer-authenticated session MCP calls, `/ping`, the two
   * runner-initiated ("connect") bootstrap calls and the public runner
   * release files to the local API. The bootstrap calls carry no Dispatch
   * credentials — none exist yet — so they are allow-listed by path and
   * method alone, exactly like `/ping`; this is what lets a clean runner
   * reach them through this listener's own pinned CA even when the ordinary
   * API is loopback-only or plain HTTP. `/install` relays the install
   * script, which the copied command fetches with this listener's key pinned,
   * and names the origin the client used so the script downloads from it.
   */
  private forward(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    onAuthenticated: () => void,
    relay: ProxyRelay | undefined
  ) {
    const url = request.url ?? "";
    const target = this.api;
    const install =
      url === RUNNER_LISTENER_INSTALL_PATH &&
      (request.method === "GET" || request.method === "HEAD");
    const artifact =
      (RUNNER_ARTIFACT_PATH.test(url) ||
        Boolean(resolveRunnerUpdatePath(url))) &&
      (request.method === "GET" || request.method === "HEAD");
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
    if (relay?.hasArtifact()) {
      response
        .writeHead(503, { Connection: "close", "Retry-After": "10" })
        .end();
      return;
    }
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
    const allowed =
      ping || mcp || connectCreate || connectPoll || artifact || install;
    if (!allowed || !target) {
      response.writeHead(allowed ? 503 : 404).end();
      return;
    }
    if ((artifact || install) && !relay?.reserveArtifact(response)) {
      response.writeHead(503, { "Retry-After": "10" }).end();
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
    if (install)
      headers[RUNNER_LISTENER_ORIGIN_HEADER] = this.listenerOrigin(
        request.headers.host
      );
    const upstream = (target.tls ? https : http).request(
      {
        host,
        port: target.port,
        method: request.method,
        path: install ? RUNNER_INSTALL_PATH : url,
        headers: { ...headers, host: `${formatHost(host)}:${target.port}` },
        // The API is on this machine; its certificate names its LAN hosts.
        rejectUnauthorized: false,
      },
      (reply) => {
        if (
          artifact &&
          request.method === "GET" &&
          reply.statusCode === 200 &&
          reply.headers["content-disposition"]?.startsWith("attachment;")
        )
          relay?.startDownload();
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
        ...(!registration.revoked && {
          automaticUpdates: registration.automaticUpdates,
        }),
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

  automaticUpdates(id: string): boolean {
    return this.registrationById(id)?.automaticUpdates === true;
  }

  async setAutomaticUpdates(id: string, automatic: boolean): Promise<void> {
    if (!(await this.enrollment?.registry.setAutomaticUpdates(id, automatic)))
      throw new RunnerRequestError(404, "Runner not found.");
    const enrolled = this.registrationById(id);
    if (enrolled) enrolled.automaticUpdates = automatic;
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
    this.revoking.add(id);
    try {
      const registration = await this.enrollment.registry.revoke(id);
      if (!registration) throw new RunnerRequestError(404, "Runner not found.");
      for (const [fingerprint, entry] of this.enrolled)
        if (entry.id === id) this.enrolled.delete(fingerprint);
      for (const peer of this.peers.values())
        if (peer.gate.registrationId === id) peer.socket.destroy();
    } finally {
      this.revoking.delete(id);
    }
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

  /**
   * Where a runner fetches this controller's install script, and the pin of
   * the listener key that authenticates it. The key changes whenever the
   * listener certificate is reissued, so the command is composed per copy.
   */
  async artifactEndpoint(hostHint?: string) {
    if (!this.enrollment)
      throw new RunnerRequestError(409, "Runner enrollment is disabled.");
    const host = await this.prepareEndpoint(hostHint);
    return {
      origin: `https://${formatHost(host)}:${this.port!}`,
      pin: publicKeyPin(this.authority!.serverCert),
    };
  }

  /** The running listener's CA and key pin, for the script it relays. */
  listenerInstall() {
    if (!this.listener || !this.authority) return undefined;
    return {
      caPem: this.authority.caPem,
      pin: publicKeyPin(this.authority.serverCert),
    };
  }

  /**
   * The listener origin as its client addressed it, which the install
   * script then downloads from; the CA it embeds verifies that host name.
   */
  private listenerOrigin(hostHeader: string | undefined) {
    const match = /^(?:\[([0-9A-Fa-f:.]+)\]|([^:[\]]+))(?::\d{1,5})?$/.exec(
      hostHeader ?? ""
    );
    const requested = match?.[1] ?? match?.[2];
    const host =
      requested && validHost(requested)
        ? requested
        : (this.enrollment?.endpointHost ?? advertisedHost(undefined));
    return `https://${formatHost(host)}:${this.port!}`;
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

  /**
   * What the runner last pushed, on this connection or an earlier one. A new
   * connection has pushed nothing while an update fence refuses engine work.
   */
  lastEngineInventory(runnerId: string): EngineInventoryEntry[] | undefined {
    const seen = this.lastSeen.get(runnerId);
    return seen?.gate.approved() ? seen.engines : undefined;
  }

  getFile(placement: Placement, agentId: string, path: string) {
    const peer = this.workspacePeer(placement);
    return receiveFile(
      {
        agentId,
        workspace: placement.workspace,
        kind: "sessionFile",
        operation: { kind: "collect", path },
      },
      (command, signal) =>
        this.request(placement, command, false, undefined, signal, peer),
      peer?.filesGetStream ? peer.streams : undefined
    );
  }

  streamTerminal(
    placement: Placement,
    agentId: string,
    dimensions: Pick<Req<"terminal.open">, "cols" | "rows">
  ) {
    const peer = this.workspacePeer(placement);
    if (!peer?.terminalOpenStream || !peer.streams) return;
    return openTerminalStream(
      { kind: "openTerminal", agentId, workspace: placement.workspace },
      dimensions,
      (command, signal) =>
        this.request(placement, command, false, undefined, signal, peer),
      peer.streams
    );
  }

  streamCheckoutExec = (
    placement: Placement,
    command: Extract<Command, { kind: "checkoutCommand" }>,
    { timeoutMs, maxOutput, shell, env }: Req<"checkout.exec">,
    signal?: AbortSignal
  ) => {
    const peer = this.workspacePeer(placement);
    if (!peer?.checkoutExecStream || !peer.streams) return;
    return receiveCheckoutExec(
      command,
      { timeoutMs, maxOutput, shell, env },
      (request, active) =>
        this.request(placement, request, false, undefined, active, peer),
      peer.streams,
      signal
    );
  };

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

  /** Status frames from runners that advertised self-update support. */
  onUpdateStatus(listener: (event: RunnerUpdateEvent) => void) {
    this.updateListeners.add(listener);
    return () => this.updateListeners.delete(listener);
  }

  /** Changes on every accepted connection; undefined while disconnected. */
  connectionEpoch(runnerId: string): number | undefined {
    const peer = this.peers.get(runnerId);
    return peer?.gate.approved() ? peer.epoch : undefined;
  }

  lastConnectionEpoch(runnerId: string): number | undefined {
    return this.lastSeen.get(runnerId)?.epoch;
  }

  runnerDescriptions(): RunnerDescription[] {
    const registrations = [...this.enrolled.values()].map(({ id, name }) => ({
      id,
      name,
    }));
    if (this.legacy)
      registrations.unshift({ id: this.legacy.id, name: this.legacy.id });
    return registrations.map(({ id, name }) => {
      const seen = this.lastSeen.get(id);
      const advert = seen?.ready.selfUpdate;
      const build = this.peers.get(id)?.health?.sample ?? seen?.build;
      return {
        runnerId: runnerIdFromWire(id),
        displayName: name,
        build: {
          version: build?.version ?? "",
          ...(build?.revision && { revision: build.revision }),
        },
        protocol: seen?.ready.version ?? RUNNER_WIRE_VERSION,
        engines: (seen?.engines ?? [])
          .filter(({ installed }) => installed)
          .map(({ id }) => id),
        capabilities: advert ? { selfUpdate: advert } : {},
      };
    });
  }

  connectedRunnerIds(): string[] {
    return [...this.peers.keys()];
  }

  /** An enrolled, unrevoked runner, online or not. */
  isRegistered(runnerId: string): boolean {
    return (
      Boolean(this.registrationById(runnerId)) || this.legacy?.id === runnerId
    );
  }

  /** The current connection's self-update advertisement, if any. */
  selfUpdate(
    runnerId: string
  ): { advert: SelfUpdateAdvert; epoch: number } | undefined {
    const peer = this.peers.get(runnerId);
    return !this.revoking.has(runnerId) &&
      peer?.gate.approved() &&
      peer.selfUpdate
      ? { advert: peer.selfUpdate, epoch: peer.epoch }
      : undefined;
  }

  /**
   * Send one validated update frame on the runner's current connection.
   * With `epoch`, refuse if the connection changed since it was read.
   * Replies arrive through `onUpdateStatus`.
   */
  sendUpdate(
    runnerId: string,
    ...[frame, epoch]:
      | [Extract<UpdateServiceFrame, { type: "update_offer" }>, epoch?: number]
      | [UpdateServiceFrame, epoch: number]
  ) {
    if (frame.type !== "update_offer" && epoch === undefined)
      throw new TypeError("A runner connection epoch is required.");
    const peer = this.peers.get(runnerId);
    if (!peer?.gate.approved())
      throw new RunnerUnavailable("The runner is disconnected or unavailable.");
    if (!peer.selfUpdate)
      throw new RunnerCapabilityUnavailable(
        "This runner does not support supervisor updates."
      );
    if (epoch !== undefined && epoch !== peer.epoch)
      throw new RunnerUnavailable("The runner connection changed.");
    const parsed = parseUpdateServiceFrame(frame);
    if (!parsed) throw new TypeError("Invalid runner update frame.");
    peer.send(parsed);
    return { epoch: peer.epoch };
  }

  offerUpdate(
    runnerId: string,
    attemptId: string,
    target: RunnerUpdateTarget,
    retry = false,
    epoch?: number
  ) {
    return this.sendUpdate(
      runnerId,
      { type: "update_offer", attemptId, target, retry },
      epoch
    );
  }

  fenceUpdate(
    runnerId: string,
    attemptId: string,
    retainSessions: boolean,
    epoch: number
  ) {
    return this.sendUpdate(
      runnerId,
      { type: "update_fence", attemptId, retainSessions },
      epoch
    );
  }

  activateUpdate(runnerId: string, attemptId: string, epoch: number) {
    return this.sendUpdate(
      runnerId,
      { type: "update_activate", attemptId },
      epoch
    );
  }

  confirmUpdate(
    runnerId: string,
    attemptId: string,
    observed: { revision: string; sha256: string },
    epoch: number
  ) {
    return this.sendUpdate(
      runnerId,
      { type: "update_confirm", attemptId, ...observed },
      epoch
    );
  }

  cancelUpdate(
    runnerId: string,
    attemptId: string,
    reason: RunnerUpdateCancelReason,
    epoch: number
  ) {
    return this.sendUpdate(
      runnerId,
      { type: "update_cancel", attemptId, reason },
      epoch
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

  async listRepositoryBranches(
    runnerId: string,
    target: { repository: string }
  ) {
    // The v1 transport only implements github.branches. The T16 transport
    // supplies git.branches for arbitrary repository targets.
    const github = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)$/.exec(
      target.repository
    );
    if (!github)
      throw new RunnerCapabilityUnavailable(
        "git.branches is unavailable on this runner."
      );
    return this.listGitHubBranches(runnerId, github[1]!, github[2]!);
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

  /** Whether the connected runner reconciles a repeated launch ID. */
  reconcilesLaunches(placement: Placement) {
    return this.peers.get(placement.runner)?.launchReconcile === true;
  }

  /**
   * The capabilities the runner's latest approved connection advertised,
   * even while it is disconnected. Only for admitting a launch that a runner
   * update holds: the launch is checked again against the reconnected peer
   * when it is released.
   */
  lastSeenCapabilities(placement: Placement) {
    const seen = this.lastSeen.get(placement.runner);
    if (
      !seen ||
      !seen.gate.approved() ||
      !seen.gate.allows(placement.workspace) ||
      !seen.workspaces.has(placement.workspace)
    )
      return undefined;
    return {
      managedWorkspace: seen.managedWorkspace,
      sessionFiles: seen.sessionFiles,
      sharedWorktree: seen.sharedWorktree,
    };
  }

  private workspacePeer(placement: Placement) {
    const peer = this.peers.get(placement.runner);
    if (
      peer?.gate.approved() &&
      peer.gate.allows(placement.workspace) &&
      peer.workspaces.has(placement.workspace)
    )
      return peer;
    return undefined;
  }

  available(placement: Placement) {
    return Boolean(this.workspacePeer(placement));
  }

  async request(
    placement: Placement,
    command: Command,
    open = false,
    onProgress?: (progress: LaunchProgress) => void,
    signal?: AbortSignal,
    expectedPeer?: Peer
  ) {
    if (
      !this.registrationById(placement.runner) &&
      placement.runner !== this.legacy?.id &&
      (await this.enrollment?.registry.isRevoked(placement.runner))
    ) {
      throw new RunnerRevoked();
    }
    const peer = this.workspacePeer(placement);
    if (
      !peer ||
      (expectedPeer && expectedPeer !== peer) ||
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
        "This runner version does not support checkout commands. Update the runner to execute checkout commands."
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
      command.launch.launchId !== undefined &&
      !peer.launchReconcile
    ) {
      // An older runner keeps the launch shape it knows.
      const { launchId: _launchId, ...launch } = command.launch;
      command = { ...command, launch };
    }
    if (
      command.kind === "launch" &&
      command.launch.prepareWorkspace &&
      !peer.workspacePreparation
    )
      throw new RunnerCapabilityUnavailable(
        "Update the runner to prepare session workspaces."
      );
    if (
      command.kind === "sessionFile" &&
      (command.operation.kind !== "collect" ||
        command.operation.streamId === undefined)
    ) {
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
