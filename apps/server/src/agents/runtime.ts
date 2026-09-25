import type { AgentPermissionsResponse } from "@dispatch/shared";
import type { PromptSource } from "./acp/prompt-source.js";
import type { FastifyBaseLogger } from "fastify";

import type { AppConfig } from "../config.js";
import type { DriverEvent } from "./acp/driver.js";
import type {
  AvailableCommand,
  SessionConfigOption,
} from "@agentclientprotocol/sdk";
import type { AcpEngineId, EngineBins } from "./acp/engine-spec.js";
import { createAcpRuntime, type AcpRuntimeDeps } from "./acp/runtime.js";

/**
 * What the manager hands to `runtime.launch()` to start an agent's host.
 * The workspace (worktree, deps) already exists; this is only about the
 * process. See docs/design/acp-runtime.md.
 */
export type RuntimeLaunch = {
  agentId: string;
  cwd: string;
  engine: AcpEngineId;
  /** Missing only in launch files written before permission support (full access). */
  fullAccess?: boolean;
  bins: EngineBins;
  /** The model to select after the session opens; null keeps the engine's default. */
  model: string | null;
  systemPrompt: string | null;
  mcp: { url: string; token: string };
  /** Environment additions for the engine child (DISPATCH_*, files dir). */
  env: Record<string, string>;
  /** Directories the engine child's PATH is prefixed with. */
  pathPrefix: string[];
  /** Resume this ACP session; null opens a new one. */
  resumeSessionId: string | null;
};

export type RuntimeEventListener = (
  agentId: string,
  event: DriverEvent,
  seq: number
) => Promise<void> | void;

/**
 * Where an agent's process lives. The manager writes one launch, stop,
 * prompt and reconcile flow against this and never branches on which
 * implementation is behind it: `AcpRuntime` (a host process per agent) or
 * `InertRuntime` (no processes; e2e and tests).
 */
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
    opts?: { alone?: boolean; delivery?: "auto" | "queue" }
  ): { accepted: Promise<void>; settled: Promise<void> };
  /** Atomically claim an unsent post at every recipient. */
  controlQueuedPrompt(
    agentIds: string[],
    blockId: string,
    action: "delete" | "send-now"
  ): boolean;
  /** A turn is running or prompts are waiting behind one. */
  isBusy(agentId: string): boolean;
  /** A turn is actually running, excluding prompts waiting in the queue. */
  hasOpenTurn(agentId: string): boolean;
  cancel(agentId: string): Promise<void>;
  /** Shut the host down; `force` skips the graceful ACP close. */
  stop(agentId: string, force: boolean): Promise<void>;
  /** Agents with a live host, for the reconciler. */
  listHosted(): Promise<string[]>;
  /** The host's pid when it is alive; the root of the agent's process tree. */
  hostPid(agentId: string): Promise<number | null>;
  /** Events in seq order, each delivered once. Listeners run serially per agent. */
  onEvent(listener: RuntimeEventListener): () => void;
  /** Tail of the host's log, for error messages. */
  readLogTail(agentId: string): Promise<string>;
  /** Remove the agent's state directory (archive). */
  discard(agentId: string): Promise<void>;
};

export function createAgentRuntime(
  config: AppConfig,
  logger: FastifyBaseLogger,
  deps: Pick<AcpRuntimeDeps, "hostSeq" | "syncJournal">
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
    async hostPid() {
      return null;
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
