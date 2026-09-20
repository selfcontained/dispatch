import type { FastifyBaseLogger } from "fastify";

import type { AppConfig } from "../config.js";
import type { DriverEvent } from "./acp/driver.js";
import type { AcpEngineId, EngineBins } from "./acp/engine-spec.js";
import { createAcpRuntime } from "./acp/runtime.js";

/**
 * What the manager hands to `runtime.launch()` to start an agent's host.
 * The workspace (worktree, deps) already exists; this is only about the
 * process. See docs/design/acp-runtime.md.
 */
export type RuntimeLaunch = {
  agentId: string;
  cwd: string;
  engine: AcpEngineId;
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
  /**
   * Queue one turn. `accepted` resolves when the engine has the prompt
   * (after any turn already running); `settled` when the turn ends.
   */
  prompt(
    agentId: string,
    text: string
  ): { accepted: Promise<void>; settled: Promise<void> };
  /** A turn is running or prompts are waiting behind one. */
  isBusy(agentId: string): boolean;
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
  deps: { hostSeq: (agentId: string) => Promise<number> }
): AgentRuntime {
  if (config.agentRuntime === "inert") {
    return createInertRuntime();
  }
  return createAcpRuntime({ config, logger, hostSeq: deps.hostSeq });
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
    prompt() {
      return { accepted: Promise.resolve(), settled: Promise.resolve() };
    },
    isBusy: () => false,
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
