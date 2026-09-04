import path from "node:path";
import type { Pool } from "pg";
import type { AgentLatestEventType, AgentRecord } from "@dispatch/shared";

import { createAgentMcpToken } from "../../auth.js";
import type { AppConfig } from "../../config.js";
import { resolveMediaDir } from "../../shared/media.js";
import { dispatchMcpUrl } from "../tmux/mcp-url.js";
import { DshDriver, type DriverEvent, type DriverLogger } from "./driver.js";
import { removeOverlay, writeOverlay } from "./overlay.js";
import { StreamRecorder } from "./stream-recorder.js";
import { StreamStore } from "./stream-store.js";
import { UsageRecorder } from "./usage-recorder.js";

export type SupervisorDeps = {
  pool: Pool;
  config: Pick<
    AppConfig,
    "dshBin" | "dshHome" | "port" | "tls" | "authToken" | "mediaRoot"
  >;
  logger: DriverLogger;
  /** Injectable for tests; defaults to a driver over the real `dsh` binary. */
  driver?: DshDriver;
  getAgent: (id: string) => Promise<AgentRecord | null>;
  setCliSessionId: (id: string, sessionId: string) => Promise<void>;
  setLatestEvent: (
    id: string,
    input: { type: AgentLatestEventType; message: string }
  ) => Promise<void>;
  /** ChatService.publishChanged: the feed re-reads after each stream write. */
  publishChat: (agentId: string) => void;
  /** Full persona text for the overlay (see persona.ts). */
  personaPromptFor: (agent: AgentRecord) => Promise<string>;
  /** dsh agents recorded as running, for {@link DshSupervisor.restoreRunning}. */
  listRunningAgentIds: () => Promise<string[]>;
  /** Record that an agent could not be brought back at boot. */
  markStartFailed: (id: string, message: string) => Promise<void>;
};

/**
 * What the dsh child must not inherit from the server process. Everything
 * else passes through, the same as the tmux login shell a CLI agent gets,
 * so git over SSH, gh, proxies, and locale behave the same in both.
 */
const ENV_DENY_EXACT = new Set([
  "DATABASE_URL",
  "TEST_DATABASE_URL",
  "PGPASSWORD",
  "PGUSER",
  "PGHOST",
  "PGPORT",
  "PGDATABASE",
  "MEDIA_ROOT",
  "TLS_CERT",
  "TLS_KEY",
  "TLS_CA",
]);
const ENV_DENY_PREFIX = "DISPATCH_";

export function buildChildEnv(input: {
  agentId: string;
  mediaDir: string;
  config: Pick<AppConfig, "port" | "tls">;
  base?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const base = input.base ?? process.env;
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (ENV_DENY_EXACT.has(key) || key.startsWith(ENV_DENY_PREFIX)) continue;
    env[key] = value;
  }
  // The same contract the pane launch exports (command-builder.ts), so
  // plugin skills and hooks the agent's shell tools run see one shape.
  env.DISPATCH_AGENT_ID = input.agentId;
  env.DISPATCH_MEDIA_DIR = input.mediaDir;
  env.DISPATCH_PORT = String(input.config.port);
  env.DISPATCH_SCHEME = input.config.tls ? "https" : "http";
  // Under TLS the MCP URL is loopback https; the child needs the CA the pane
  // launch also exports, or every Dispatch tool call fails verification.
  if (input.config.tls && base.TLS_CA && !env.NODE_EXTRA_CA_CERTS) {
    env.NODE_EXTRA_CA_CERTS = base.TLS_CA;
  }
  return env;
}

const MESSAGE_MAX = 200;
const STOP_ALL_TIMEOUT_MS = 5_000;

/**
 * Glue between the agent lifecycle and the ACP driver: starts dsh when an
 * agent's setup completes, turns prompts into turns with working/idle status
 * around them, folds the stream into the store and usage table, and stops
 * the child when the agent stops.
 */
export class DshSupervisor {
  private readonly driver: DshDriver;
  private readonly streams: StreamRecorder;
  private readonly usage: UsageRecorder;
  private readonly context = new Map<
    string,
    { sessionId: string; model: string }
  >();
  /**
   * One writer per agent. Driver events arrive faster than their DB writes
   * settle; handled concurrently, two appends compute the same seq and one
   * dies on the unique index, and chunk accumulation sees stale open-row
   * state. Chaining each agent's events keeps order and the invariant.
   */
  private readonly queues = new Map<string, Promise<void>>();
  /**
   * One turn at a time per agent. ACP allows one active prompt per session;
   * a prompt that arrives mid-turn waits and runs as the next turn.
   */
  private readonly turns = new Map<string, Promise<void>>();

  constructor(private readonly deps: SupervisorDeps) {
    this.driver =
      deps.driver ??
      new DshDriver({
        dshBin: deps.config.dshBin,
        dshHome: deps.config.dshHome,
        logger: deps.logger,
      });
    this.streams = new StreamRecorder(new StreamStore(deps.pool));
    this.usage = new UsageRecorder(deps.pool);
    this.driver.onEvent((event) => {
      const prior = this.queues.get(event.agentId) ?? Promise.resolve();
      const next = prior.then(() => this.onEvent(event));
      this.queues.set(event.agentId, next);
      void next.finally(() => {
        if (this.queues.get(event.agentId) === next) {
          this.queues.delete(event.agentId);
        }
      });
    });
  }

  isRunning(agentId: string): boolean {
    return this.driver.isRunning(agentId);
  }

  /** A turn is running or queued for this agent. */
  isBusy(agentId: string): boolean {
    return this.turns.has(agentId);
  }

  private overlayDir(): string {
    return path.join(this.deps.config.dshHome, "overlays");
  }

  async start(agentId: string): Promise<void> {
    const agent = await this.deps.getAgent(agentId);
    if (!agent || agent.type !== "dsh") {
      throw new Error(`${agentId} is not a dsh agent`);
    }
    const overlayPath = await writeOverlay(this.overlayDir(), agentId, {
      model: agent.model ?? null,
      persona: await this.deps.personaPromptFor(agent),
    });
    const mediaDir = resolveMediaDir(
      agentId,
      agent.mediaDir,
      this.deps.config.mediaRoot
    );
    this.streams.setCwd(agentId, agent.cwd);
    const { sessionId, resumed } = await this.driver.start({
      agentId,
      cwd: agent.cwd,
      overlayPath,
      mcp: {
        url: dispatchMcpUrl(this.deps.config, agentId),
        token: createAgentMcpToken(this.deps.config.authToken, agentId),
      },
      sessionId: agent.cliSessionId ?? null,
      env: buildChildEnv({ agentId, mediaDir, config: this.deps.config }),
    });
    this.context.set(agentId, { sessionId, model: agent.model ?? "default" });
    await this.deps.setCliSessionId(agentId, sessionId);
    await this.deps.setLatestEvent(agentId, {
      type: "idle",
      message: resumed ? "dsh session resumed." : "dsh session started.",
    });
  }

  /**
   * Bring back every dsh agent recorded as running after a server restart.
   * The stored session id resumes; an agent that cannot come back is marked
   * failed rather than left "running" with nothing behind it.
   */
  async restoreRunning(): Promise<{ restored: string[]; failed: string[] }> {
    const restored: string[] = [];
    const failed: string[] = [];
    for (const id of await this.deps.listRunningAgentIds()) {
      try {
        await this.start(id);
        restored.push(id);
      } catch (err) {
        failed.push(id);
        const message = (err as Error).message;
        this.deps.logger.warn(
          { err, agentId: id },
          "dsh agent could not be restored at boot"
        );
        await this.deps
          .markStartFailed(id, message.slice(0, MESSAGE_MAX))
          .catch(() => {});
      }
    }
    return { restored, failed };
  }

  /**
   * Queue one turn. `started` resolves when the turn begins (earlier turns
   * for the agent have settled); `settled` resolves when it ends and never
   * rejects.
   */
  enqueuePrompt(
    agentId: string,
    text: string
  ): { started: Promise<void>; settled: Promise<void> } {
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const prior = this.turns.get(agentId) ?? Promise.resolve();
    // runTurn only rejects if the pre-try status write throws; never let
    // that skip the next turn and strand its `started`.
    const run: Promise<void> = prior
      .catch(() => {})
      .then(() =>
        this.runTurn(
          agentId,
          text,
          markStarted,
          () => this.turns.get(agentId) === run
        )
      );
    this.turns.set(agentId, run);
    void run.finally(() => {
      if (this.turns.get(agentId) === run) this.turns.delete(agentId);
    });
    return { started, settled: run };
  }

  /** Runs one turn after any queued before it; resolves when it settles. */
  async prompt(agentId: string, text: string): Promise<void> {
    await this.enqueuePrompt(agentId, text).settled;
  }

  private async runTurn(
    agentId: string,
    text: string,
    markStarted: () => void,
    isLastQueued: () => boolean
  ): Promise<void> {
    markStarted();
    await this.deps.setLatestEvent(agentId, {
      type: "working",
      message: "Working on the latest message.",
    });
    try {
      await this.driver.prompt(agentId, text);
      await this.drained(agentId);
      if (isLastQueued()) {
        await this.deps.setLatestEvent(agentId, {
          type: "idle",
          message: "Turn finished.",
        });
      }
    } catch (err) {
      const message = (err as Error).message;
      this.deps.logger.warn({ err, agentId }, "dsh prompt failed");
      if (isLastQueued()) {
        await this.deps.setLatestEvent(agentId, {
          type: "idle",
          message: `Turn failed: ${message}`.slice(0, MESSAGE_MAX),
        });
      }
    }
  }

  async cancel(agentId: string): Promise<void> {
    if (!this.driver.isRunning(agentId)) return;
    await this.driver.cancel(agentId);
  }

  async stop(agentId: string): Promise<void> {
    await this.driver.stop(agentId);
    this.context.delete(agentId);
    await removeOverlay(this.overlayDir(), agentId);
  }

  /** Server shutdown: stop every child through the teardown ladder, bounded. */
  async stopAll(): Promise<void> {
    const ids = this.driver.liveAgentIds();
    if (ids.length === 0) return;
    await Promise.race([
      Promise.allSettled(ids.map((id) => this.stop(id))),
      new Promise((resolve) => setTimeout(resolve, STOP_ALL_TIMEOUT_MS)),
    ]);
  }

  /** Resolves once every event queued so far for the agent has been handled. */
  private async drained(agentId: string): Promise<void> {
    await this.queues.get(agentId);
  }

  private async onEvent(event: DriverEvent): Promise<void> {
    try {
      await this.streams.handle(event);
      const ctx = this.context.get(event.agentId);
      if (ctx) await this.usage.handle(event, ctx);
      this.deps.publishChat(event.agentId);
      if (event.type === "exit" && !event.expected) {
        this.context.delete(event.agentId);
        if (event.code !== 0) {
          await this.deps.setLatestEvent(event.agentId, {
            type: "blocked",
            message: `dsh exited (${event.code ?? event.signal ?? "unknown"}).`,
          });
        }
      }
    } catch (err) {
      this.deps.logger.warn(
        { err, agentId: event.agentId },
        "dsh event handling failed"
      );
    }
  }
}
