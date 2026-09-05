import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Pool } from "pg";
import type {
  AgentLatestEventType,
  AgentRecord,
  HarnessConfigOption,
} from "@dispatch/shared";

import { createAgentMcpToken, createJobMcpToken } from "../../auth.js";
import type { AppConfig } from "../../config.js";
import { resolveMediaDir } from "../../shared/media.js";
import { dispatchMcpUrl } from "../tmux/mcp-url.js";
import { DshDriver, type DriverEvent, type DriverLogger } from "./driver.js";
import { appendCommandLog, commandLogPath } from "./command-log.js";
import { removeOverlay, writeOverlay } from "./overlay.js";
import { parsePromptSource, type PromptSource } from "./prompt-source.js";
import type { AgentModelOption } from "../../shared/agent-models.js";
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
   * dsh takes no launch argument, so the supervisor sends it as the first
   * turn of a fresh session.
   */
  launchPromptFor: (agentId: string) => Promise<string | null>;
  /** dsh agents recorded as running, for {@link DshSupervisor.restoreRunning}. */
  listRunningAgentIds: () => Promise<string[]>;
  /** Record that an agent could not be brought back at boot. */
  markStartFailed: (id: string, message: string) => Promise<void>;
  /** Persist a model switched mid-session, so a restart resumes on it. */
  setAgentModel?: (id: string, model: string | null) => Promise<void>;
  /**
   * The child exited without Dispatch asking it to: the agent must not stay
   * "running" over a dead harness. Falls back to a blocked event.
   */
  markExited?: (id: string, message: string) => Promise<void>;
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

/** A prompt waiting its turn, as the Harness view lists it. */
export type QueuedPrompt = {
  /** The chat message id for a chat prompt; otherwise a queue-local id. */
  id: string;
  source: PromptSource;
  createdAt: string;
};

type Pending = QueuedPrompt & {
  text: string;
  started: Promise<void>;
  markStarted: () => void;
  failStarted: (err: Error) => void;
  settled: Promise<void>;
  markSettled: () => void;
};

/**
 * When no model was chosen, pick one whose provider key the service has, so
 * a first agent does not fail on the profile's DeepSeek default with only an
 * OpenAI key configured. Null keeps the profile default.
 */
/**
 * Which env key each dsh provider route needs. A route without its key
 * still shows in dsh's options, but every call on it would fail, so the
 * catalog and the picker drop it. Unknown routes are kept.
 */
export const PROVIDER_KEY_ENV: Record<string, string> = {
  "deepseek-official": "DEEPSEEK_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
  gemini: "GEMINI_API_KEY",
};

type SelectOption = {
  value: string;
  name: string;
  description?: string | null;
};
type SelectGroup = {
  groupId?: string;
  group?: string;
  name: string;
  options: SelectOption[];
};

/**
 * Which of a route's models are offered. dsh serves OpenAI's whole
 * back-catalog; only the current generation is worth a menu entry. A
 * route without an entry offers everything. The session's current value
 * always stays listed so a picker can show what is running.
 */
export const CATALOG_MODEL_ALLOW: Record<string, RegExp> = {
  openai: /^gpt-5\.6/,
};

function modelNameOf(value: string): string {
  const id = modelIdFromValue(value);
  return id ? id.slice(id.indexOf("/") + 1) : value;
}

function groupIdOf(group: SelectGroup): string {
  return group.groupId ?? group.group ?? "";
}

function isGroup(entry: unknown): entry is SelectGroup {
  return (
    typeof entry === "object" &&
    entry !== null &&
    Array.isArray((entry as SelectGroup).options)
  );
}

/**
 * dsh's "model" option lists every route it serves; keep only the routes
 * whose API key the service has. Other options pass through untouched.
 */
export function filterConfigOptionsByKeys(
  options: HarnessConfigOption[],
  env: NodeJS.ProcessEnv
): HarnessConfigOption[] {
  return options.map((option) => {
    if (option.id !== "model" || option.type !== "select") return option;
    const entries = option.options as unknown[];
    const kept = entries
      .filter((entry) => {
        if (!isGroup(entry)) return true;
        const key = PROVIDER_KEY_ENV[groupIdOf(entry)];
        return key === undefined || !!env[key];
      })
      .map((entry) => {
        if (!isGroup(entry)) return entry;
        const allow = CATALOG_MODEL_ALLOW[groupIdOf(entry)];
        if (!allow) return entry;
        return {
          ...entry,
          options: entry.options.filter(
            (c) =>
              c.value === option.currentValue ||
              allow.test(modelNameOf(c.value))
          ),
        };
      })
      .filter((entry) => !isGroup(entry) || entry.options.length > 0);
    return { ...option, options: kept as HarnessConfigOption["options"] };
  });
}

/** Flatten the "model" option into catalog rows: id `provider/model`. */
export function catalogFromConfigOptions(
  options: HarnessConfigOption[]
): AgentModelOption[] {
  const model = options.find((o) => o.id === "model" && o.type === "select");
  if (!model) return [];
  const rows: AgentModelOption[] = [];
  const push = (entry: SelectOption, groupName?: string) => {
    const id = modelIdFromValue(entry.value);
    if (!id) return;
    rows.push({
      id,
      label: entry.name,
      ...(groupName ? { group: groupName } : {}),
    });
  };
  for (const entry of model.options as unknown[]) {
    if (isGroup(entry)) {
      for (const option of entry.options) push(option, entry.name);
    } else if (typeof entry === "object" && entry !== null) {
      push(entry as SelectOption);
    }
  }
  return rows;
}

/** dsh encodes a model value as the JSON pair ["provider","model"]. */
export function modelIdFromValue(value: string): string | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
    ) {
      return `${parsed[0]}/${parsed[1]}`;
    }
  } catch {
    // not JSON: fall through
  }
  return value.includes("/") ? value : null;
}

const CATALOG_TTL_MS = 10 * 60_000;

export function defaultModelFor(env: NodeJS.ProcessEnv): string | null {
  if (env.DEEPSEEK_API_KEY) return "deepseek-official/deepseek-v4-flash";
  if (env.OPENAI_API_KEY) return "openai/gpt-5.6-sol";
  return null;
}

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
   * a prompt that arrives mid-turn waits in `pending` and runs as the next
   * turn once `running` clears. The list is explicit so the view can show
   * it and the user can reorder or drop what has not started.
   */
  private readonly pending = new Map<string, Pending[]>();
  private readonly running = new Map<string, Pending>();
  private catalog: { at: number; rows: AgentModelOption[] } | null = null;
  private catalogInFlight: Promise<AgentModelOption[]> | null = null;

  constructor(private readonly deps: SupervisorDeps) {
    this.driver =
      deps.driver ??
      new DshDriver({
        dshBin: deps.config.dshBin,
        dshHome: deps.config.dshHome,
        logger: deps.logger,
      });
    this.streams = new StreamRecorder(new StreamStore(deps.pool), {
      commandLog: (agentId, entry) =>
        appendCommandLog(commandLogPath(deps.config.dshHome, agentId), entry),
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

  /** A turn is running or queued for this agent. */
  isBusy(agentId: string): boolean {
    return this.running.has(agentId) || this.pendingOf(agentId).length > 0;
  }

  private pendingOf(agentId: string): Pending[] {
    return this.pending.get(agentId) ?? [];
  }

  /** What waits behind the running turn, first to run first. */
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
    this.deps.publishChat(agentId);
    return true;
  }

  /** Move a queued prompt to the front; it runs as the next turn. */
  promoteQueued(agentId: string, id: string): boolean {
    const list = this.pendingOf(agentId);
    const index = list.findIndex((item) => item.id === id);
    if (index === -1) return false;
    if (index > 0) {
      const [item] = list.splice(index, 1);
      list.unshift(item);
      this.deps.publishChat(agentId);
    }
    return true;
  }

  /**
   * Cancel the running turn. It settles as cancelled and the next queued
   * prompt starts. Nothing running: nothing happens.
   */
  async interrupt(agentId: string): Promise<boolean> {
    if (!this.running.has(agentId) || !this.driver.isRunning(agentId)) {
      return false;
    }
    await this.driver.cancel(agentId);
    return true;
  }

  /** "Send now": the prompt goes first, and the running turn is cut short. */
  async sendQueuedNow(agentId: string, id: string): Promise<boolean> {
    if (!this.promoteQueued(agentId, id)) return false;
    await this.interrupt(agentId);
    return true;
  }

  /** The running session's options (model, effort), keyed providers only. */
  getConfigOptions(agentId: string): HarnessConfigOption[] | null {
    const options = this.driver.getConfigOptions(agentId);
    return options
      ? filterConfigOptionsByKeys(options as HarnessConfigOption[], process.env)
      : null;
  }

  /** Switch a session option; a model switch is also stored on the agent. */
  async setConfigOption(
    agentId: string,
    configId: string,
    value: string
  ): Promise<HarnessConfigOption[]> {
    const options = await this.driver.setConfigOption(agentId, configId, value);
    if (configId === "model") {
      const model = modelIdFromValue(value);
      if (model) {
        const ctx = this.context.get(agentId);
        if (ctx) ctx.model = model;
        await this.deps.setAgentModel?.(agentId, model);
      }
    }
    return filterConfigOptionsByKeys(
      options as HarnessConfigOption[],
      process.env
    );
  }

  /**
   * The models dsh serves, for the create dialog: read off a running agent
   * when one exists, otherwise from a throwaway probe session; cached.
   */
  async modelCatalog(): Promise<AgentModelOption[]> {
    const now = Date.now();
    if (this.catalog && now - this.catalog.at < CATALOG_TTL_MS) {
      return this.catalog.rows;
    }
    for (const agentId of this.driver.liveAgentIds()) {
      const options = this.getConfigOptions(agentId);
      const rows = options ? catalogFromConfigOptions(options) : [];
      if (rows.length) {
        this.catalog = { at: now, rows };
        return rows;
      }
    }
    if (this.catalogInFlight) return this.catalogInFlight;
    this.catalogInFlight = (async () => {
      const overlayPath = await writeOverlay(
        this.overlayDir(),
        "catalog-probe",
        {
          model: null,
          persona: "",
        }
      );
      try {
        const options = await this.driver.probeConfigOptions({
          overlayPath,
          cwd: this.deps.config.dshHome,
          env: buildChildEnv({
            agentId: "catalog-probe",
            mediaDir: this.deps.config.mediaRoot,
            config: this.deps.config,
          }),
        });
        const rows = catalogFromConfigOptions(
          filterConfigOptionsByKeys(
            options as HarnessConfigOption[],
            process.env
          )
        );
        this.catalog = { at: Date.now(), rows };
        return rows;
      } catch (err) {
        // No dsh here (or a broken one): remember briefly so a dialog that
        // reopens does not spawn a failing child each time.
        this.deps.logger.warn({ err }, "dsh model catalog probe failed");
        this.catalog = { at: Date.now() - CATALOG_TTL_MS + 60_000, rows: [] };
        return [];
      } finally {
        this.catalogInFlight = null;
        await removeOverlay(this.overlayDir(), "catalog-probe");
      }
    })();
    return this.catalogInFlight;
  }

  private overlayDir(): string {
    return path.join(this.deps.config.dshHome, "overlays");
  }

  async start(agentId: string): Promise<void> {
    const agent = await this.deps.getAgent(agentId);
    if (!agent || agent.type !== "dsh") {
      throw new Error(`${agentId} is not a dsh agent`);
    }
    const model = agent.model ?? defaultModelFor(process.env);
    // Rows a previous process left open (restart mid-turn) settle first,
    // so the view never shows a turn that can no longer finish.
    await this.streams.reconcile(agentId);
    const jobRunId = (await this.deps.activeJobRunIdFor?.(agentId)) ?? null;
    const overlayPath = await writeOverlay(this.overlayDir(), agentId, {
      model,
      persona: await this.deps.personaPromptFor(agent, jobRunId),
    });
    const mediaDir = resolveMediaDir(
      agentId,
      agent.mediaDir,
      this.deps.config.mediaRoot
    );
    this.streams.setCwd(agentId, agent.cwd);
    let session: { sessionId: string; resumed: boolean };
    try {
      session = await this.driver.start({
        agentId,
        cwd: agent.cwd,
        overlayPath,
        mcp: {
          url: dispatchMcpUrl(this.deps.config, agentId, jobRunId ?? undefined),
          token: jobRunId
            ? createJobMcpToken(this.deps.config.authToken, jobRunId, agentId)
            : createAgentMcpToken(this.deps.config.authToken, agentId),
        },
        sessionId: agent.cliSessionId ?? null,
        env: buildChildEnv({ agentId, mediaDir, config: this.deps.config }),
      });
    } catch (err) {
      // The overlay holds the persona text; nothing is running to use it.
      await removeOverlay(this.overlayDir(), agentId);
      throw err;
    }
    const { sessionId, resumed } = session;
    this.context.set(agentId, { sessionId, model: model ?? "default" });
    await this.deps.setCliSessionId(agentId, sessionId);
    await this.deps.setLatestEvent(agentId, {
      type: "idle",
      message: resumed ? "dsh session resumed." : "dsh session started.",
    });
    // A fresh session gets the launch prompt as its first turn; a resumed
    // one already had it.
    if (!agent.cliSessionId) {
      const first = await this.deps.launchPromptFor(agentId);
      if (first) {
        this.enqueuePrompt(agentId, first).settled.catch((err: unknown) => {
          this.deps.logger.warn({ err, agentId }, "dsh first turn failed");
        });
      }
    }
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
    if (this.pendingOf(agentId).includes(item)) this.deps.publishChat(agentId);
    return { started, settled };
  }

  /** Start the next queued prompt when nothing runs; runs itself again after. */
  private pump(agentId: string): void {
    if (this.running.has(agentId)) return;
    const list = this.pendingOf(agentId);
    const next = list.shift();
    if (list.length === 0) this.pending.delete(agentId);
    if (!next) return;
    this.running.set(agentId, next);
    next.markStarted();
    void this.runTurn(
      agentId,
      next.text,
      () => this.pendingOf(agentId).length === 0
    )
      .catch(() => {})
      .finally(() => {
        if (this.running.get(agentId) === next) this.running.delete(agentId);
        next.markSettled();
        this.pump(agentId);
      });
  }

  /** Drop everything queued for the agent, failing each prompt's start. */
  private flushQueued(agentId: string, reason: string): void {
    const list = this.pendingOf(agentId);
    this.pending.delete(agentId);
    for (const item of list) {
      item.failStarted(new Error(reason));
      item.markSettled();
    }
    if (list.length > 0) this.deps.publishChat(agentId);
  }

  /** Runs one turn after any queued before it; resolves when it settles. */
  async prompt(agentId: string, text: string): Promise<void> {
    await this.enqueuePrompt(agentId, text).settled;
  }

  private async runTurn(
    agentId: string,
    text: string,
    isLastQueued: () => boolean
  ): Promise<void> {
    let startedAt: string | null = null;
    try {
      await this.deps.setLatestEvent(agentId, {
        type: "working",
        message: "Working on the latest message.",
      });
      startedAt =
        (await this.deps.getAgent(agentId))?.latestEvent?.updatedAt ?? null;
      await this.driver.prompt(agentId, text);
      await this.drained(agentId);
      if (isLastQueued()) {
        await this.settle(agentId, startedAt, {
          type: "idle",
          message: "Turn finished.",
        });
      }
    } catch (err) {
      const message = (err as Error).message;
      this.deps.logger.warn({ err, agentId }, "dsh prompt failed");
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

  async cancel(agentId: string): Promise<void> {
    if (!this.driver.isRunning(agentId)) return;
    await this.driver.cancel(agentId);
  }

  async stop(agentId: string): Promise<void> {
    this.flushQueued(agentId, "The agent stopped before the message was sent.");
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
        // Any unexpected exit, code 0 included: a "running" agent over a
        // dead child takes every prompt to a 409.
        const message = `dsh exited (${event.code ?? event.signal ?? "unknown"}); press Start to relaunch.`;
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
        "dsh event handling failed"
      );
    }
  }
}
