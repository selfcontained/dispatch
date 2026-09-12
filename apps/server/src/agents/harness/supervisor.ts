import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Pool } from "pg";
import {
  DEFAULT_HARNESS_MODEL,
  HARNESS_ENGINES,
  type AgentLatestEventType,
  type AgentRecord,
  type HarnessCommand,
  type HarnessConfigOption,
  type HarnessEngineId,
} from "@dispatch/shared";

import { createAgentMcpToken, createJobMcpToken } from "../../auth.js";
import type { AppConfig } from "../../config.js";
import { resolveMediaDir } from "../../shared/media.js";
import { dispatchMcpUrl } from "../tmux/mcp-url.js";
import { engineSpecFor, splitModelId, type EngineBins } from "./agent-spec.js";
import {
  HarnessDriver,
  resolveExecutable,
  TEARDOWN_STEP_MS,
  type DriverEvent,
  type DriverLogger,
} from "./driver.js";
import { parsePromptSource, type QueuedPrompt } from "./prompt-source.js";
import { FLUSH_INTERVAL_MS, StreamRecorder } from "./stream-recorder.js";
import { StreamStore } from "./stream-store.js";
import { UsageRecorder } from "./usage-recorder.js";

export type SupervisorDeps = {
  pool: Pool;
  config: Pick<
    AppConfig,
    | "claudeHarnessBin"
    | "codexHarnessBin"
    | "geminiBin"
    | "opencodeBin"
    | "claudeBin"
    | "codexBin"
    | "dispatchBinDir"
    | "port"
    | "tls"
    | "authToken"
    | "mediaRoot"
  >;
  logger: DriverLogger;
  driver?: HarnessDriver;
  resolveBinary?: (bin: string, env: NodeJS.ProcessEnv) => Promise<string>;
  getAgent: (id: string) => Promise<AgentRecord | null>;
  setCliSessionId: (id: string, sessionId: string) => Promise<void>;
  setLatestEvent: (
    id: string,
    input: { type: AgentLatestEventType; message: string }
  ) => Promise<void>;
  /**
   * ChatService.publishHarnessChanged: the queue is re-read after each
   * stream write, and the turn itself is published separately as a feed
   * row; `config` marks a session start, settle, or option switch, when
   * the session config is worth re-reading too.
   */
  publishHarness: (agentId: string, config?: boolean) => void;
  personaPromptFor: (
    agent: AgentRecord,
    jobRunId: string | null
  ) => Promise<string>;
  /**
   * The job run this agent is executing, if any: the harness then attaches
   * the job MCP route (job_complete, job_failed, …) with the job token,
   * exactly as the pane launch does.
   */
  activeJobRunIdFor?: (agentId: string) => Promise<string | null>;
  /**
   * The agent's launch prompt, already wrapped as a chat envelope, or null.
   * The harness takes no launch argument, so the supervisor sends it as the
   * first turn of a fresh session.
   */
  launchPromptFor: (agentId: string) => Promise<string | null>;
  listRunningAgentIds: () => Promise<string[]>;
  markStartFailed: (id: string, message: string) => Promise<void>;
  setAgentModel?: (id: string, model: string | null) => Promise<void>;
  /**
   * The child exited without Dispatch asking it to: the agent must not stay
   * "running" over a dead harness. Falls back to a blocked event.
   */
  markExited?: (id: string, message: string) => Promise<void>;
};

/**
 * What the harness child must not inherit from the server process.
 * Everything else passes through, the same as the tmux login shell a CLI
 * agent gets, so git over SSH, gh, proxies, and locale behave the same in
 * both.
 *
 * The three engine API keys are on the list because each engine
 * authenticates through the host CLI's own login, and a key left in the
 * service environment would quietly authenticate the engine as someone else
 * and bill that account instead. `GEMINI_API_KEY` is deliberately not on the
 * list: it is one of Gemini CLI's supported logins, and the runbook says so.
 */
const ENV_DENY_EXACT = new Set([
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "ANTHROPIC_API_KEY",
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
  config: Pick<AppConfig, "port" | "tls" | "dispatchBinDir">;
  base?: NodeJS.ProcessEnv;
  engine?: HarnessEngineId;
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
  // The pane launch prepends the same two entries (command-builder.ts). The
  // service units pin PATH to
  // /usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin, which
  // holds neither Dispatch's own bin/ nor the ~/.local/bin the runbook's
  // install recipe uses, so without this an engine a pane agent launches
  // fine is "not found on the server's PATH" here, and so is every tool the
  // engine's shell runs. `resolveBinary` reads this same PATH.
  const localBin = base.HOME ? path.join(base.HOME, ".local/bin") : null;
  const entries = [input.config.dispatchBinDir, localBin]
    .concat(env.PATH ? env.PATH.split(path.delimiter) : [])
    .filter((entry): entry is string => Boolean(entry));
  env.PATH = Array.from(new Set(entries)).join(path.delimiter);
  // Pin the Bash tool's cwd to the project root after every command, as the
  // pane launch does, so it does not drift back to the original repo root
  // over a long conversation. Claude Code's own variable; the other engines
  // have no equivalent.
  if (input.engine === "claude") {
    env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR = "1";
  }
  return env;
}

function modelOptionOf(
  options: readonly HarnessConfigOption[]
): HarnessConfigOption | undefined {
  return options.find((o) => o.id === "model" || o.category === "model");
}

function isModelOption(
  options: readonly HarnessConfigOption[],
  configId: string
): boolean {
  return modelOptionOf(options)?.id === configId;
}

/**
 * How much of a Claude turn's reply is kept to test the logged-out answer
 * against. The phrase has to open the reply, so a few hundred characters is
 * already more than the check can use.
 */
const LOGIN_REPLY_MAX_CHARS = 300;

/**
 * Claude Code's logged-out answer, anchored to the start of the turn's
 * reply. Anchored rather than matched anywhere in it because the phrase is
 * ordinary prose: this repo's own runbook prints that command, so an agent
 * asked about the runbook could otherwise write the phrase and have its
 * session stopped mid-work.
 */
const LOGIN_REPLY_RE = /^\s*please run \/login\b/i;

/**
 * True when `err` is the ACP SDK's `RequestError.authRequired` (JSON-RPC
 * code -32000) or otherwise says the engine needs a login, so a session
 * start or a boot restore can end with a message the starting screen shows
 * next to the engine's login command instead of a generic failure.
 */
export function loginFailureMessage(
  engine: HarnessEngineId,
  err: unknown
): string | null {
  if (typeof err !== "object" || err === null) return null;
  const code = (err as { code?: unknown }).code;
  const message = (err as { message?: unknown }).message;
  const isLoginFailure =
    code === -32000 ||
    (typeof message === "string" &&
      /authentication required|not logged in|please run \/login/i.test(
        message
      ));
  if (!isLoginFailure) return null;
  const label = HARNESS_ENGINES.find((e) => e.id === engine)?.label ?? engine;
  return `${label} is not logged in on the server.`;
}

const MESSAGE_MAX = 200;
/**
 * The ceiling on the stop race in {@link HarnessSupervisor.stopAll}. Derived
 * from the driver's ladder (close, stdin EOF, SIGTERM, SIGKILL) plus a second
 * of slack, so a well-behaved child always gets the whole ladder rather than
 * being cut off a few hundred milliseconds short of its own SIGKILL.
 */
const STOP_ALL_TIMEOUT_MS = 4 * TEARDOWN_STEP_MS + 1_000;
const RECONCILE_TIMEOUT_MS = 2_000;

/**
 * Sent as the first turn after a restart to an agent whose previous turn
 * the restart cut short. The session log carries everything the model did
 * up to the cut, so it can pick the task up rather than start over.
 */
export const RESTART_PROMPT = [
  "--- DISPATCH: RESTART ---",
  'Dispatch restarted while your previous turn was running, so that turn ended early (it is marked "interrupted by restart"). Pick the task back up from where you left off: check the current state of any files you were changing before redoing work, then continue.',
  "--- END DISPATCH: RESTART ---",
].join("\n");

type Pending = QueuedPrompt & {
  text: string;
  started: Promise<void>;
  markStarted: () => void;
  failStarted: (err: Error) => void;
  settled: Promise<void>;
  markSettled: () => void;
};

/**
 * Glue between the agent lifecycle and the ACP driver: picks the engine
 * from the agent's model id, starts it when an agent's setup completes,
 * delivers the persona the way the engine takes it, turns prompts into
 * turns with working/idle status around them, folds the stream into the
 * store and the usage table, and stops the child when the agent stops.
 */
export class HarnessSupervisor {
  private readonly driver: HarnessDriver;
  private readonly store: StreamStore;
  private readonly streams: StreamRecorder;
  private readonly usage: UsageRecorder;
  private readonly resolveBinary: (
    bin: string,
    env: NodeJS.ProcessEnv
  ) => Promise<string>;
  private readonly context = new Map<
    string,
    { sessionId: string; engine: HarnessEngineId; model: string }
  >();
  /**
   * Persona text an engine takes as the leading block of its first prompt
   * (see EngineSpec.personaDelivery); set at a fresh start, or at a resume
   * of a session that never ran a turn; consumed by the first turn.
   */
  private readonly pendingPersona = new Map<string, string>();
  /**
   * One writer per agent. Driver events arrive faster than their DB writes
   * settle; handled concurrently, two appends compute the same seq and one
   * dies on the unique index, and chunk accumulation sees stale open-row
   * state. Chaining each agent's events keeps order and the invariant.
   */
  private readonly queues = new Map<string, Promise<void>>();
  /**
   * One turn at a time per agent. ACP allows one active prompt per session;
   * a prompt that arrives mid-turn waits in `pending` and runs as the next
   * turn once `running` clears. The list is explicit so the view can show
   * it and the user can reorder or drop what has not started.
   */
  private readonly pending = new Map<string, Pending[]>();
  private readonly running = new Map<string, Pending>();
  /**
   * Claude Code has no `auth_required` error; it answers a turn with a plain
   * "Please run /login" reply instead. What the current Claude turn has
   * said, capped, and whether it called a tool: a turn that used a tool is
   * working, not refusing to start, so the answer is only read as logged out
   * when it opens the reply of a turn that did nothing else. Kept per turn
   * and read when it settles: {@link onEvent}.
   */
  private readonly turnReply = new Map<
    string,
    { text: string; toolCall: boolean }
  >();
  /**
   * Per-agent trailing timers that coalesce the publishes streamed updates
   * drive. One ACP notification arrives per token chunk, and every publish
   * is an SSE frame to every connected client that invalidates both the chat
   * feed and the whole turn list. The window matches the recorder's own
   * flush interval, so a client re-reads no more often than the rows change.
   * A turn boundary or an exit publishes at once and takes the pending
   * timer with it: {@link onEvent}.
   */
  private readonly publishTimers = new Map<string, NodeJS.Timeout>();
  /**
   * Set by {@link stopAll} before it snapshots what is running, so the
   * snapshot cannot grow behind it: {@link pump} starts nothing more once
   * shutdown has begun.
   */
  private shuttingDown = false;

  constructor(private readonly deps: SupervisorDeps) {
    this.resolveBinary = deps.resolveBinary ?? resolveExecutable;
    this.driver =
      deps.driver ??
      new HarnessDriver({
        logger: deps.logger,
        resolveBinary: this.resolveBinary,
      });
    this.store = new StreamStore(deps.pool);
    this.streams = new StreamRecorder(this.store, {
      // A round the engine ran on its own settles by going quiet; the view
      // learns of it the same way it learns of every other stream write.
      onAutonomousSettled: (agentId) => {
        deps.publishHarness(agentId, true);
        // A late adapter event can open a promptless round after the prompt
        // promise resolved. Do not overlap the next queued prompt with it.
        this.pump(agentId);
      },
    });
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

  isBusy(agentId: string): boolean {
    return (
      this.running.has(agentId) ||
      this.streams.hasAutonomousTurn(agentId) ||
      this.pendingOf(agentId).length > 0
    );
  }

  private pendingOf(agentId: string): Pending[] {
    return this.pending.get(agentId) ?? [];
  }

  listQueued(agentId: string): QueuedPrompt[] {
    return this.pendingOf(agentId).map(({ id, source, createdAt }) => ({
      id,
      source,
      createdAt,
    }));
  }

  /**
   * Drop a prompt that has not started. Its `started` rejects, so a chat
   * message settles as not delivered rather than pending forever.
   */
  removeQueued(agentId: string, id: string): boolean {
    const list = this.pendingOf(agentId);
    const index = list.findIndex((item) => item.id === id);
    if (index === -1) return false;
    const [item] = list.splice(index, 1);
    if (list.length === 0) this.pending.delete(agentId);
    item.failStarted(new Error("Removed from the queue before it started."));
    item.markSettled();
    this.deps.publishHarness(agentId);
    return true;
  }

  promoteQueued(agentId: string, id: string): boolean {
    const list = this.pendingOf(agentId);
    const index = list.findIndex((item) => item.id === id);
    if (index === -1) return false;
    if (index > 0) {
      const [item] = list.splice(index, 1);
      list.unshift(item);
      this.deps.publishHarness(agentId);
    }
    return true;
  }

  /**
   * Cancel the running turn. It settles as cancelled and the next queued
   * prompt starts. Nothing running: nothing happens.
   */
  async interrupt(agentId: string): Promise<boolean> {
    if (!this.driver.isRunning(agentId)) return false;
    if (this.running.has(agentId)) {
      await this.driver.cancel(agentId);
      return true;
    }
    if (!this.streams.hasAutonomousTurn(agentId)) return false;
    // Keep the autonomous row open until the cancel RPC finishes. Its
    // settlement callback pumps queued prompts, so closing first could start
    // a new prompt and direct this cancel at that new work instead.
    await this.driver.cancel(agentId).catch((err: unknown) => {
      this.deps.logger.warn(
        { err, agentId },
        "could not cancel a late autonomous harness turn"
      );
    });
    // Even if the adapter says it has no active prompt, close the visible
    // stream turn and let its settlement callback safely resume the queue.
    await this.streams.interruptAutonomous(agentId);
    return true;
  }

  async sendQueuedNow(agentId: string, id: string): Promise<boolean> {
    if (!this.promoteQueued(agentId, id)) return false;
    await this.interrupt(agentId);
    return true;
  }

  getConfigOptions(agentId: string): HarnessConfigOption[] | null {
    const options = this.driver.getConfigOptions(agentId);
    return options ? (options as HarnessConfigOption[]) : null;
  }

  getSessionStartedAt(agentId: string): string | null {
    return this.driver.getSessionStartedAt(agentId);
  }

  getCommands(agentId: string): HarnessCommand[] | null {
    const commands = this.driver.getCommands(agentId);
    return commands
      ? commands.map((c) => ({
          name: c.name,
          description: c.description,
          ...(c.input ? { input: { hint: c.input.hint } } : {}),
        }))
      : null;
  }

  async setConfigOption(
    agentId: string,
    configId: string,
    value: string
  ): Promise<HarnessConfigOption[]> {
    const options = await this.driver.setConfigOption(agentId, configId, value);
    const ctx = this.context.get(agentId);
    if (ctx && isModelOption(options as HarnessConfigOption[], configId)) {
      ctx.model = value;
      await this.deps.setAgentModel?.(agentId, `${ctx.engine}/${value}`);
    }
    // Another client's picker shows the switch without waiting for a poll.
    this.deps.publishHarness(agentId, true);
    return options as HarnessConfigOption[];
  }

  /** How long after a restart cut a turn the agent is still told to resume it. */
  static readonly RESTART_RESUME_WINDOW_MS = 60 * 60_000;

  async start(agentId: string): Promise<{ resumed: boolean }> {
    const agent = await this.deps.getAgent(agentId);
    if (!agent || agent.type !== "dispatch") {
      throw new Error(`${agentId} is not a Dispatch Harness agent`);
    }
    const { engine, model } = splitModelId(
      agent.model ?? DEFAULT_HARNESS_MODEL
    );
    // Rows a previous process left open (restart mid-turn) settle first,
    // so the view never shows a turn that can no longer finish.
    await this.streams.reconcile(agentId);
    const jobRunId = (await this.deps.activeJobRunIdFor?.(agentId)) ?? null;
    const persona = await this.deps.personaPromptFor(agent, jobRunId);
    const mediaDir = resolveMediaDir(
      agentId,
      agent.mediaDir,
      this.deps.config.mediaRoot
    );
    const env = buildChildEnv({
      agentId,
      mediaDir,
      config: this.deps.config,
      engine,
    });
    const spec = engineSpecFor(engine, model, await this.binsFor(engine, env));
    this.streams.setCwd(agentId, agent.cwd);
    let session: { sessionId: string; resumed: boolean };
    try {
      session = await this.driver.start({
        agentId,
        cwd: agent.cwd,
        engine: spec,
        systemPromptAppend:
          spec.personaDelivery === "system_prompt" ? persona : null,
        mcp: {
          url: dispatchMcpUrl(this.deps.config, agentId, jobRunId ?? undefined),
          token: jobRunId
            ? createJobMcpToken(this.deps.config.authToken, jobRunId, agentId)
            : createAgentMcpToken(this.deps.config.authToken, agentId),
        },
        sessionId: agent.cliSessionId ?? null,
        env,
      });
    } catch (err) {
      // An auth_required failure at launch names the engine, so the caller's
      // status message tells the operator what to run instead of just that
      // the start failed.
      const login = loginFailureMessage(engine, err);
      throw login ? new Error(login) : err;
    }
    const { sessionId, resumed } = session;
    this.context.set(agentId, { sessionId, engine, model });
    // An engine that takes the persona in its first prompt gets it once: on a
    // fresh session, or on a resumed session that never ran a turn (the
    // process stopped between opening the session and its first prompt). A
    // resumed session with a turn behind it has the persona in its history.
    // The read is agent-scoped, not session-scoped: turn rows carry no
    // session id, so an agent whose earlier session ran turns but whose
    // replacement session was stopped before its first turn keeps its
    // history and gets no persona; a deliberate trade, not an oversight.
    const neverRan = (await this.store.lastTurnSettlement(agentId)) === null;
    if (spec.personaDelivery === "first_prompt" && (!resumed || neverRan)) {
      this.pendingPersona.set(agentId, persona);
    } else {
      this.pendingPersona.delete(agentId);
    }
    if (model !== "default" && !spec.modelFixedAtLaunch) {
      await this.applyModel(agentId, model);
    }
    await this.deps.setCliSessionId(agentId, sessionId);
    await this.deps.setLatestEvent(agentId, {
      type: "idle",
      // A stored session that came back as a fresh one is not a first
      // start: the engine could not resume (Gemini CLI answers session/
      // resume with "method not found"), so its own history is gone even
      // though Dispatch still has every turn.
      message: resumed
        ? "Harness session resumed."
        : agent.cliSessionId
          ? "Session restarted; this engine cannot resume, so Dispatch keeps the turns."
          : "Harness session started.",
    });
    // The session's options exist from here: the picker can read them.
    this.deps.publishHarness(agentId, true);
    // A fresh session gets the launch prompt as its first turn; so does a
    // resumed one that never ran a turn. A resumed session with a turn
    // behind it already had it.
    if (!agent.cliSessionId || neverRan) {
      const first = await this.deps.launchPromptFor(agentId);
      if (first) {
        this.enqueuePrompt(agentId, first).settled.catch((err: unknown) => {
          this.deps.logger.warn({ err, agentId }, "harness first turn failed");
        });
      }
    }
    return { resumed };
  }

  /**
   * The binaries a spec needs, resolved to absolute paths: an engine's
   * adapter finds the host CLI through an env var, and the service's PATH
   * is not a login shell's. The host codex is only named when configured.
   */
  private async binsFor(
    engine: HarnessEngineId,
    env: NodeJS.ProcessEnv
  ): Promise<EngineBins> {
    const c = this.deps.config;
    return {
      claudeHarnessBin: c.claudeHarnessBin,
      codexHarnessBin: c.codexHarnessBin,
      geminiBin: c.geminiBin,
      opencodeBin: c.opencodeBin,
      claudeBin:
        engine === "claude"
          ? await this.resolveBinary(c.claudeBin, env)
          : c.claudeBin,
      codexBin:
        engine === "codex" && process.env.DISPATCH_CODEX_BIN
          ? await this.resolveBinary(c.codexBin, env)
          : null,
    };
  }

  /** A stored model that is not the engine's default is applied through its model option. */
  private async applyModel(agentId: string, model: string): Promise<void> {
    const options = this.driver.getConfigOptions(agentId) ?? [];
    const option = modelOptionOf(options as HarnessConfigOption[]);
    if (!option) {
      this.deps.logger.warn(
        { agentId, model },
        "the engine publishes no model option; keeping its default model"
      );
      return;
    }
    try {
      await this.driver.setConfigOption(agentId, option.id, model);
    } catch (err) {
      this.deps.logger.warn(
        { err, agentId, model },
        "the engine refused the stored model; keeping its default"
      );
    }
  }

  /**
   * Bring back every harness agent recorded as running after a server
   * restart. The stored session id resumes; an agent that cannot come back
   * is marked failed rather than left "running" with nothing behind it.
   */
  async restoreRunning(): Promise<{ restored: string[]; failed: string[] }> {
    const restored: string[] = [];
    const failed: string[] = [];
    for (const id of await this.deps.listRunningAgentIds()) {
      try {
        // start() overwrites latestEvent with "session resumed", so what
        // the agent last said about itself is read before that.
        const lastSaid = (await this.deps.getAgent(id))?.latestEvent?.type;
        const { resumed } = await this.start(id);
        restored.push(id);
        if (resumed && (await this.shouldResumeAfterRestart(id, lastSaid))) {
          this.enqueuePrompt(id, RESTART_PROMPT).settled.catch(
            (err: unknown) => {
              this.deps.logger.warn(
                { err, agentId: id },
                "harness restart follow-up turn failed"
              );
            }
          );
        }
      } catch (err) {
        failed.push(id);
        // start() already maps an auth_required failure to the login
        // message before it reaches here; re-derive the engine and map
        // again so the stored message names it even if that ever changes.
        const engine = await this.engineFor(id);
        const login = engine ? loginFailureMessage(engine, err) : null;
        const message = login ?? (err as Error).message;
        this.deps.logger.warn(
          { err, agentId: id },
          "harness agent could not be restored at boot"
        );
        await this.deps
          .markStartFailed(id, message.slice(0, MESSAGE_MAX))
          .catch(() => {});
      }
    }
    return { restored, failed };
  }

  private async engineFor(agentId: string): Promise<HarnessEngineId | null> {
    try {
      const agent = await this.deps.getAgent(agentId);
      if (!agent) return null;
      return splitModelId(agent.model ?? DEFAULT_HARNESS_MODEL).engine;
    } catch {
      return null;
    }
  }

  /**
   * A turn the restart cut short continues only when the cut is recent
   * (an agent idle for days is not billed a turn at every boot), the
   * session really resumed (a fresh session has no memory to continue
   * from), and the agent had not already declared itself done, blocked,
   * or waiting on someone.
   */
  private async shouldResumeAfterRestart(
    agentId: string,
    lastSaid: string | undefined
  ): Promise<boolean> {
    const cutAt = await this.streams.lastTurnInterruptedByRestartAt(agentId);
    if (!cutAt) return false;
    if (
      Date.now() - cutAt.getTime() >
      HarnessSupervisor.RESTART_RESUME_WINDOW_MS
    ) {
      return false;
    }
    return (
      lastSaid !== "done" &&
      lastSaid !== "blocked" &&
      lastSaid !== "waiting_user"
    );
  }

  /**
   * Queue one turn. `started` resolves when the turn begins (earlier turns
   * for the agent have settled) and rejects if the prompt is removed or the
   * agent stops first; `settled` resolves when it ends and never rejects.
   */
  enqueuePrompt(
    agentId: string,
    text: string
  ): { started: Promise<void>; settled: Promise<void> } {
    const source = parsePromptSource(text);
    let markStarted: () => void = () => {};
    let failStarted: (err: Error) => void = () => {};
    const started = new Promise<void>((resolve, reject) => {
      markStarted = resolve;
      failStarted = reject;
    });
    // A caller that only waits on `settled` must not turn a removal into
    // an unhandled rejection.
    started.catch(() => {});
    let markSettled: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    const item: Pending = {
      id: source.source === "chat" ? source.chatMessageId : `q_${randomUUID()}`,
      source,
      createdAt: new Date().toISOString(),
      text,
      started,
      markStarted,
      failStarted,
      settled,
      markSettled,
    };
    const list = this.pendingOf(agentId);
    list.push(item);
    this.pending.set(agentId, list);
    this.pump(agentId);
    // Still waiting: no stream write announces it, so tell the feed here
    // and the view lists it at once.
    if (this.pendingOf(agentId).includes(item))
      this.deps.publishHarness(agentId);
    return { started, settled };
  }

  /** Start the next queued prompt when nothing runs; runs itself again after. */
  private pump(agentId: string): void {
    // Shutdown has begun: what is queued stays queued, so a chat message
    // keeps its undelivered row for the next boot to redeliver rather than
    // starting a turn the teardown is about to cut.
    if (this.shuttingDown) return;
    // Some adapters emit tool activity after their prompt promise resolves.
    // That becomes an autonomous stream turn, and ACP still permits only one
    // active session turn, so defer queued prompts until it settles.
    if (this.running.has(agentId) || this.streams.hasAutonomousTurn(agentId)) {
      return;
    }
    const list = this.pendingOf(agentId);
    const next = list.shift();
    if (list.length === 0) this.pending.delete(agentId);
    if (!next) return;
    // The slot is claimed here, synchronously, because `isBusy` and the
    // queue order read it. `started` is not resolved here: it waits for the
    // engine to accept the prompt, so a chat message is never recorded as
    // delivered to a child that has already gone away.
    this.running.set(agentId, next);
    void this.runTurn(
      agentId,
      next.text,
      () => this.pendingOf(agentId).length === 0,
      next
    )
      .catch(() => {})
      .finally(() => {
        if (this.running.get(agentId) === next) this.running.delete(agentId);
        next.markSettled();
        this.pump(agentId);
      });
  }

  /**
   * Drop everything queued for the agent, failing each prompt's start.
   * With `keepChat`, chat messages are dropped from memory but their
   * `started` is left pending: the chat row stays `delivered: null`, and
   * the next boot delivers it again (see ChatService.redeliverPending).
   */
  private flushQueued(
    agentId: string,
    reason: string,
    opts: { keepChat?: boolean } = {}
  ): void {
    const list = this.pendingOf(agentId);
    this.pending.delete(agentId);
    for (const item of list) {
      if (!(opts.keepChat && item.source.source === "chat")) {
        item.failStarted(new Error(reason));
      }
      item.markSettled();
    }
    if (list.length > 0) this.deps.publishHarness(agentId);
  }

  async prompt(agentId: string, text: string): Promise<void> {
    await this.enqueuePrompt(agentId, text).settled;
  }

  private async runTurn(
    agentId: string,
    text: string,
    isLastQueued: () => boolean,
    item?: Pending
  ): Promise<void> {
    let startedAt: string | null = null;
    const persona = this.pendingPersona.get(agentId);
    if (persona !== undefined) {
      this.pendingPersona.delete(agentId);
      text = `${persona}\n\n${text}`;
    }
    try {
      await this.deps.setLatestEvent(agentId, {
        type: "working",
        message: "Working on the latest message.",
      });
      startedAt =
        (await this.deps.getAgent(agentId))?.latestEvent?.updatedAt ?? null;
      await this.driver.prompt(agentId, text, () => item?.markStarted());
      await this.drained(agentId);
      if (isLastQueued()) {
        await this.settle(agentId, startedAt, {
          type: "idle",
          message: "Turn finished.",
        });
      }
    } catch (err) {
      const message = (err as Error).message;
      this.deps.logger.warn({ err, agentId }, "harness prompt failed");
      // A prompt that never reached the engine leaves its caller a
      // rejection, so a chat message settles as not delivered instead of
      // waiting for ever. A no-op once the engine accepted the prompt.
      item?.failStarted(err as Error);
      if (isLastQueued()) {
        await this.settle(agentId, startedAt, {
          type: "idle",
          message: `Turn failed: ${message}`.slice(0, MESSAGE_MAX),
        }).catch(() => {});
      }
    }
  }

  /**
   * The settle-time status yields to a terminal status the agent set during
   * the turn: a reviewer's `done`, a question's `waiting_user`, a `blocked`.
   * Those come from dispatch_event inside the turn and would otherwise be
   * overwritten milliseconds later.
   */
  private async settle(
    agentId: string,
    startedAt: string | null,
    input: { type: AgentLatestEventType; message: string }
  ): Promise<void> {
    const current = (await this.deps.getAgent(agentId))?.latestEvent;
    const terminal =
      current &&
      (current.type === "done" ||
        current.type === "blocked" ||
        current.type === "waiting_user");
    if (terminal && (startedAt === null || current.updatedAt > startedAt)) {
      return;
    }
    await this.deps.setLatestEvent(agentId, input);
  }

  async stop(
    agentId: string,
    opts: { keepChat?: boolean } = {}
  ): Promise<void> {
    this.flushQueued(
      agentId,
      "The agent stopped before the message was sent.",
      opts
    );
    await this.driver.stop(agentId);
    this.context.delete(agentId);
    this.turnReply.delete(agentId);
    this.pendingPersona.delete(agentId);
  }

  /** Server shutdown: stop every child through the teardown ladder, bounded. */
  async stopAll(): Promise<void> {
    const ids = this.driver.liveAgentIds();
    if (ids.length === 0) return;
    this.shuttingDown = true;
    // A turn still running is the restart's doing, not the agent's: mark it
    // so the next boot knows to resume it, before the exit settles it as
    // merely cancelled. Bounded: a slow database must not hold the
    // shutdown past launchd's patience; the next boot settles the row too.
    await Promise.race([
      Promise.allSettled(
        ids
          .filter((id) => this.running.has(id))
          .map((id) => this.streams.reconcile(id))
      ),
      new Promise((resolve) => setTimeout(resolve, RECONCILE_TIMEOUT_MS)),
    ]);
    await Promise.race([
      Promise.allSettled(ids.map((id) => this.stop(id, { keepChat: true }))),
      new Promise((resolve) => setTimeout(resolve, STOP_ALL_TIMEOUT_MS)),
    ]);
    // Whatever the ladder did not finish, end here and now. Returning with a
    // child still live hands the caller's process.exit() an orphan holding
    // full-access permissions and a live MCP token.
    const killed = this.driver.killAll();
    if (killed.length > 0) {
      this.deps.logger.warn(
        { agentIds: killed },
        "harness children did not exit in time and were killed"
      );
    }
  }

  private publishNow(agentId: string, config: boolean): void {
    const timer = this.publishTimers.get(agentId);
    if (timer) {
      clearTimeout(timer);
      this.publishTimers.delete(agentId);
    }
    this.deps.publishHarness(agentId, config);
  }

  private publishCoalesced(agentId: string): void {
    if (this.publishTimers.has(agentId)) return;
    const timer = setTimeout(() => {
      this.publishTimers.delete(agentId);
      this.deps.publishHarness(agentId);
    }, FLUSH_INTERVAL_MS);
    timer.unref?.();
    this.publishTimers.set(agentId, timer);
  }

  private async drained(agentId: string): Promise<void> {
    await this.queues.get(agentId);
  }

  private async onEvent(event: DriverEvent): Promise<void> {
    try {
      await this.streams.handle(event);
      const ctx = this.context.get(event.agentId);
      // The usage table's model column is what the token-by-model report
      // groups on: without the engine, every engine's "default" model
      // collapses into one row.
      if (ctx) {
        await this.usage.handle(event, {
          sessionId: ctx.sessionId,
          model: `${ctx.engine}/${ctx.model}`,
        });
      }
      // A turn boundary or the child going away changes the running state, so
      // it publishes at once; a streamed update rides the trailing timer.
      if (event.type === "turn" || event.type === "exit") {
        this.publishNow(event.agentId, true);
      } else {
        this.publishCoalesced(event.agentId);
      }
      // Claude Code has no auth_required error; it answers a turn saying to
      // run /login instead. Accumulate what this turn says, so the check
      // runs against the opening of the whole reply rather than one chunk,
      // and note a tool call, which rules the answer out.
      if (event.type === "turn" && event.state === "started") {
        if (ctx?.engine === "claude") {
          this.turnReply.set(event.agentId, { text: "", toolCall: false });
        } else {
          this.turnReply.delete(event.agentId);
        }
      }
      const reply =
        event.type === "update" ? this.turnReply.get(event.agentId) : undefined;
      if (reply && event.type === "update") {
        if (event.update.sessionUpdate === "tool_call") {
          reply.toolCall = true;
        } else if (
          event.update.sessionUpdate === "agent_message_chunk" &&
          event.update.content.type === "text" &&
          reply.text.length < LOGIN_REPLY_MAX_CHARS
        ) {
          reply.text = (reply.text + event.update.content.text).slice(
            0,
            LOGIN_REPLY_MAX_CHARS
          );
        }
      }
      // Read at the boundary, before the turn's own handling below, so the
      // exit that stop() triggers is not read by the unexpected-exit branch
      // that follows.
      const settledReply =
        event.type === "turn" && event.state === "settled"
          ? this.turnReply.get(event.agentId)
          : undefined;
      if (settledReply) this.turnReply.delete(event.agentId);
      if (
        settledReply &&
        !settledReply.toolCall &&
        LOGIN_REPLY_RE.test(settledReply.text.trim())
      ) {
        // stop() marks its live entry as stopping before it closes the
        // session, so the exit event that follows carries expected: true
        // and never reaches the unexpected-exit branch below, so this
        // message is the one that stands.
        await this.driver.stop(event.agentId);
        const message = "Claude Code is not logged in on the server.";
        if (this.deps.markExited) {
          await this.deps.markExited(event.agentId, message);
        } else {
          await this.deps.setLatestEvent(event.agentId, {
            type: "blocked",
            message,
          });
        }
      }
      if (event.type === "exit" && !event.expected) {
        this.context.delete(event.agentId);
        this.turnReply.delete(event.agentId);
        // Any unexpected exit, code 0 included: a "running" agent over a
        // dead child takes every prompt to a 409.
        const message = `The engine exited (${event.code ?? event.signal ?? "unknown"}); press Start to relaunch.`;
        if (this.deps.markExited) {
          await this.deps.markExited(event.agentId, message);
        } else {
          await this.deps.setLatestEvent(event.agentId, {
            type: "blocked",
            message,
          });
        }
      }
    } catch (err) {
      this.deps.logger.warn(
        { err, agentId: event.agentId },
        "harness event handling failed"
      );
    }
  }
}
