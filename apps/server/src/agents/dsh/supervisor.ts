import path from "node:path";
import type { Pool } from "pg";
import type { AgentLatestEventType, AgentRecord } from "@dispatch/shared";

import { createAgentMcpToken } from "../../auth.js";
import type { AppConfig } from "../../config.js";
import { dispatchMcpUrl } from "../tmux/mcp-url.js";
import { DshDriver, type DriverEvent, type DriverLogger } from "./driver.js";
import { writeOverlay } from "./overlay.js";
import { StreamRecorder } from "./stream-recorder.js";
import { StreamStore } from "./stream-store.js";
import { UsageRecorder } from "./usage-recorder.js";

export type SupervisorDeps = {
  pool: Pool;
  config: Pick<AppConfig, "dshBin" | "dshHome" | "port" | "tls" | "authToken">;
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
};

/**
 * Environment the dsh child inherits from the server. Provider keys ride
 * along when set; everything else stays out so the child sees a clean shell.
 */
const PASSTHROUGH_ENV = [
  "PATH",
  "HOME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
];

const MESSAGE_MAX = 200;

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

  async start(agentId: string): Promise<void> {
    const agent = await this.deps.getAgent(agentId);
    if (!agent || agent.type !== "dsh") {
      throw new Error(`${agentId} is not a dsh agent`);
    }
    const overlayPath = await writeOverlay(
      path.join(this.deps.config.dshHome, "overlays"),
      agentId,
      {
        model: agent.model ?? null,
        persona: await this.deps.personaPromptFor(agent),
      }
    );
    const env: NodeJS.ProcessEnv = {};
    for (const key of PASSTHROUGH_ENV) {
      if (process.env[key]) env[key] = process.env[key];
    }
    env.DISPATCH_AGENT_ID = agentId;
    const { sessionId } = await this.driver.start({
      agentId,
      cwd: agent.cwd,
      overlayPath,
      mcp: {
        url: dispatchMcpUrl(this.deps.config as AppConfig, agentId),
        token: createAgentMcpToken(this.deps.config.authToken, agentId),
      },
      sessionId: agent.cliSessionId ?? null,
      env,
    });
    this.context.set(agentId, { sessionId, model: agent.model ?? "default" });
    await this.deps.setCliSessionId(agentId, sessionId);
    await this.deps.setLatestEvent(agentId, {
      type: "idle",
      message: agent.cliSessionId
        ? "dsh session resumed."
        : "dsh session started.",
    });
  }

  /** Runs one turn. Resolves after the turn settles; never throws. */
  async prompt(agentId: string, text: string): Promise<void> {
    await this.deps.setLatestEvent(agentId, {
      type: "working",
      message: "Working on the latest message.",
    });
    try {
      await this.driver.prompt(agentId, text);
      await this.drained(agentId);
      await this.deps.setLatestEvent(agentId, {
        type: "idle",
        message: "Turn finished.",
      });
    } catch (err) {
      const message = (err as Error).message;
      this.deps.logger.warn({ err, agentId }, "dsh prompt failed");
      await this.deps.setLatestEvent(agentId, {
        type: "idle",
        message: `Turn failed: ${message}`.slice(0, MESSAGE_MAX),
      });
    }
  }

  async cancel(agentId: string): Promise<void> {
    if (!this.driver.isRunning(agentId)) return;
    await this.driver.cancel(agentId);
  }

  async stop(agentId: string): Promise<void> {
    await this.driver.stop(agentId);
    this.context.delete(agentId);
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
      if (event.type === "exit" && event.code !== 0 && ctx) {
        // ctx still set means we did not stop it ourselves.
        this.context.delete(event.agentId);
        await this.deps.setLatestEvent(event.agentId, {
          type: "blocked",
          message: `dsh exited (${event.code ?? event.signal ?? "unknown"}).`,
        });
      }
    } catch (err) {
      this.deps.logger.warn(
        { err, agentId: event.agentId },
        "dsh event handling failed"
      );
    }
  }
}
