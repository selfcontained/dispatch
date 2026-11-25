import type { Res } from "@dispatch/runner-protocol/contract";
import type { BackgroundSnapshot } from "@dispatch/shared";
import type { AgentMcpInventoryResponse } from "@dispatch/shared";
import type { AgentInputState } from "@dispatch/shared";
import type { AgentPermissionsResponse } from "@dispatch/shared";
import type { PromptSource, PromptOptions } from "./acp/prompt-source.js";
import type { FastifyBaseLogger } from "fastify";

import type {
  LaunchProgress,
  Placement,
  RunnerRepository,
} from "./remote/protocol.js";
import type { BuildIdentity } from "./build-identity.js";
import type {
  HostLaunch,
  PromptReceiptState,
} from "@dispatch/runner-protocol/host";
import type { AppConfig } from "../config.js";
import type { DriverEvent } from "@dispatch/runner-protocol/host";
import type {
  AvailableCommand,
  SessionConfigOption,
} from "@agentclientprotocol/sdk";
import { createAcpRuntime, type AcpRuntimeDeps } from "./acp/runtime.js";

/**
 * What the manager hands to `runtime.launch()` to start an agent's host.
 * Native preparation supplies an effective cwd before launch. Enrolled
 * runners prepare their own session workspace as part of launch.
 */
export type RuntimeLaunch = Omit<HostLaunch, "bins" | "env" | "pathPrefix"> & {
  /** The adapter is the runtime's own setting, never a launch's. */
  bins?: Omit<HostLaunch["bins"], "adapter">;
  env?: HostLaunch["env"];
  pathPrefix?: HostLaunch["pathPrefix"];
  placement?: Placement;
  repository?: RunnerRepository;
  onWorkspaceProgress?: (progress: LaunchProgress) => void;
  /** Recheck ownership after waiting for a runner whose launch reply was lost. */
  beforeLaunchReconcile?: () => Promise<void>;
  requireResume?: true;
};

export type RuntimeEventListener = (
  agentId: string,
  event: DriverEvent,
  seq: number,
  receivedRemotely?: boolean
) => Promise<void> | void;

/**
 * Where an agent's process lives. The manager writes one launch, stop,
 * prompt and reconcile flow against this and never branches on which
 * implementation is behind it: `AcpRuntime` (a host process per agent) or
 * `InertRuntime` (no processes; e2e and tests).
 */
/** What a person can do to a post still waiting in an agent's queue. */
export type QueuedPromptAction = "delete" | "send-now" | "interrupt";

/**
 * Whether a queued post was claimed. `"interrupt"` means a `send-now` was
 * carried out as an interrupt for at least one recipient, because the post
 * belongs to a different conversation from the turn running there.
 */
export type QueuedPromptControl = boolean | "interrupt";

export type RunnerHostIdentity = {
  agentId: string;
  build: BuildIdentity | undefined;
  instanceId: string | undefined;
  quiesceSupported: boolean;
  /**
   * The runner connection that carries this host's completed attach: its
   * welcome and journal replay. Absent while not fully attached.
   */
  attachedEpoch?: number;
};

export type RunnerHostRecycleHold = {
  quiesce(): Promise<boolean>;
  current(): boolean;
  shutdown(): Promise<boolean>;
  release(): void;
};

export type AgentRuntime = {
  /** Whether hosts are real processes whose absence means the agent died. */
  tracksProcesses(): boolean;
  /** Spawn the host, connect, and wait for a running engine. Throws on failure. */
  launch(
    input: RuntimeLaunch
  ): Promise<{ sessionId: string; resumed: boolean }>;
  /** Reconnect to a host that outlived the server; false when it is gone. */
  attach(agentId: string): Promise<boolean>;
  isAlive(agentId: string): Promise<boolean>;
  runnerHosts?(runnerId: string): RunnerHostIdentity[];
  wakeRunnerDrain?(runnerId: string): void;
  runnerHostAlive?(runnerId: string, agentId: string): Promise<boolean>;
  holdForRecycle?(
    runnerId: string,
    host: RunnerHostIdentity,
    drainEpoch?: number
  ): RunnerHostRecycleHold | null;
  /**
   * A forced update takes over this runner's hosts: their queues outlive
   * them, and nothing wakes a turn that is about to be cut.
   */
  holdRunnerHosts?(runnerId: string): void;
  /** The host is still there after all: attach to it, keeping its queue. */
  reattachRunnerHost?(agentId: string): void;
  releaseRunnerHost?(agentId: string): void;
  /** The session the attached host runs; undefined while it cannot say. */
  runnerHostSession?(agentId: string): string | undefined;
  /** This host is not the agent's session: let go, delivering nothing to it. */
  disownRunnerHost?(agentId: string): void;
  releaseRunnerHosts?(runnerId: string): void;
  /** The open turn, once everything received before the call is recorded. */
  runnerTurn?(agentId: string): Promise<{ open: boolean; seq?: number } | null>;
  /**
   * Interrupt exactly this turn, at most once. True once it no longer runs,
   * or when this host cannot interrupt it.
   */
  interruptRunnerTurn?(agentId: string, seq: number): Promise<boolean>;
  /** Stop a host without waiting on its update hold or needing a lease. */
  stopRunnerHost?(runnerId: string, agentId: string): Promise<void>;
  promptReceipt?(
    agentId: string,
    id: string
  ): Promise<PromptReceiptState | "unsupported" | undefined>;
  /** Inspect an existing session without starting it or submitting chat. */
  getMcpInventory(agentId: string): Promise<AgentMcpInventoryResponse>;
  getBackgroundWork?(agentId: string): Promise<BackgroundSnapshot>;
  /** Commands the live ACP session advertises; null without a live host. */
  getCommands(agentId: string): AvailableCommand[] | null;
  /** The live session's config options (model, effort, mode); null without a live host. */
  getConfigOptions(agentId: string): SessionConfigOption[] | null;
  getPermissions(agentId: string): AgentPermissionsResponse;
  answerPermission(
    agentId: string,
    requestId: string,
    optionId: string | null
  ): Promise<void>;
  /**
   * Set one config option on the live session. Resolves with the engine's
   * options once it took the value; the `config` event follows as usual.
   */
  setConfigOption(
    agentId: string,
    configId: string,
    value: string
  ): Promise<SessionConfigOption[]>;
  /**
   * Queue one turn. `accepted` resolves when the engine has the prompt
   * (after any turn already running); `settled` when the turn ends.
   */
  prompt(
    agentId: string,
    text: string,
    /**
     * What the prompt is, for Dispatch's own bookkeeping: it comes back on
     * the turn's started event, so the stream knows which block opened the
     * turn without reading the envelope back out of the text.
     */
    source?: PromptSource,
    /**
     * `alone`: never combine this prompt with others waiting beside it. A
     * post sent to interrupt is the point of its own turn.
     */
    opts?: PromptOptions
  ): { accepted: Promise<void>; settled: Promise<void> };
  /**
   * Atomically claim an unsent post at every recipient. `send-now` steers
   * it into the running turn when the post is in that turn's conversation,
   * and otherwise interrupts it; `interrupt` stops that turn and gives the
   * post its own turn next.
   */
  controlQueuedPrompt(
    agentIds: string[],
    blockId: string,
    action: QueuedPromptAction
  ): QueuedPromptControl;
  /** Interrupt the current turns without changing or resubmitting deliveries. */
  interruptDelivery?(agentIds: string[], blockId: string): Promise<boolean>;
  /** A turn is running or prompts are waiting behind one. */
  isBusy(agentId: string): boolean;
  /** A turn is actually running, excluding prompts waiting in the queue. */
  hasOpenTurn(agentId: string): boolean;
  inputState?(agentId: string): AgentInputState;
  cancel(agentId: string): Promise<void>;
  /** Shut the host down; `force` skips the graceful ACP close. */
  stop(
    agentId: string,
    force: boolean,
    expectedLaunchId?: string
  ): Promise<void>;
  /** Retry a persisted stop without touching the current live channel. */
  retryStop?(
    agentId: string,
    force: boolean,
    placement: Placement | null,
    expectedLaunchId?: string,
    ownerOnly?: boolean
  ): Promise<void>;
  /** Local recovery diagnostics. Capabilities are known only after hello. */
  inspectNativeHost?(sessionHandle: string): Promise<{
    sessionHandle: string;
    processState: "live" | "gone" | "stale";
    activity: "busy" | "idle" | "unknown";
    attached: boolean;
    capabilities: {
      steering: boolean;
      interrupt: boolean;
      mcpInventory: boolean;
      backgroundWork: boolean;
    } | null;
    cursor: { seq: number; journalId: string | null } | null;
  }>;
  stopIdleHostForRecovery?(agentId: string): Promise<boolean>;
  /** Agents with a live host, for the reconciler. */
  listHosted(): Promise<string[]>;
  listSessions?(
    placement: Placement | null,
    ownerOnly?: boolean
  ): Promise<Res<"session.list"> | undefined>;
  listRunnerSessions?(
    runnerId: string
  ): Promise<Res<"session.list"> | undefined>;
  sampleSessions?(
    placement: Placement | null,
    agentIds: string[]
  ): Promise<Res<"session.sample">["samples"]>;
  inventoryLiveness?(): (agentId: string) => Promise<boolean>;
  /** Events in seq order, each delivered once. Listeners run serially per agent. */
  onEvent(listener: RuntimeEventListener): () => void;
  /** Tail of the host's log, for error messages. */
  readLogTail(agentId: string): Promise<string>;
  /** Remove the agent's state directory (archive). */
  discard(agentId: string): Promise<void>;
  /** Clear Dispatch-side delivery state after stopping a remote host. */
  clearRemoteState?(agentId: string): Promise<void>;
};

export function createAgentRuntime(
  config: AppConfig,
  logger: FastifyBaseLogger,
  deps: Pick<
    AcpRuntimeDeps,
    | "hostSeq"
    | "syncJournal"
    | "preparePromptFiles"
    | "remoteInbox"
    | "recoverRemoteEvent"
    | "classifySteering"
    | "remote"
    | "holds"
    | "placement"
    | "localRunner"
    | "recordLaunch"
    | "sessionOwner"
  >
): AgentRuntime {
  if (config.agentRuntime === "inert") {
    return createInertRuntime();
  }
  return createAcpRuntime({ config, logger, ...deps });
}

/**
 * Inert runtime: no hosts, no engines. Prompts resolve at once and are
 * dropped; every agent reads as alive so the reconciler leaves the DB rows
 * alone. What e2e runs against when no engine is installed.
 */
export function createInertRuntime(): AgentRuntime {
  return {
    tracksProcesses: () => false,
    async launch() {
      return { sessionId: "inert", resumed: false };
    },
    async attach() {
      return true;
    },
    async isAlive() {
      return true;
    },
    async getBackgroundWork() {
      return { status: "offline", items: [] };
    },
    async getMcpInventory(agentId) {
      return { agentId, status: "offline", inventory: null };
    },
    getCommands() {
      return null;
    },
    getConfigOptions() {
      return null;
    },
    getPermissions() {
      return { connected: false, requests: [] };
    },
    async answerPermission() {
      throw new Error("No engine is attached in this environment.");
    },
    async setConfigOption() {
      throw new Error("No engine is attached in this environment.");
    },
    prompt() {
      return { accepted: Promise.resolve(), settled: Promise.resolve() };
    },
    controlQueuedPrompt: () => false,
    isBusy: () => false,
    hasOpenTurn: () => false,
    async cancel() {},
    async stop() {},
    async listHosted() {
      return [];
    },
    onEvent() {
      return () => {};
    },
    async readLogTail() {
      return "";
    },
    async discard() {},
  };
}
