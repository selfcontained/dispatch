import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";

import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";

import type { AppConfig } from "../config.js";
import {
  createDiagnosticsRecorder,
  type DiagnosticsRecorder,
} from "../diagnostics.js";
import {
  assertSafeRefName,
  createGitWorktree,
  GitWorktreeError,
  worktreePathSlug,
} from "../shared/git/worktree.js";
import { readWorktreeStatus } from "../shared/git/worktree-status.js";
import { resolveMediaDir } from "../shared/media.js";
import {
  buildGitContextForWorktree,
  probeGitContext,
} from "../shared/git/git-context.js";
import { getActivePersonality } from "../db/personalities.js";
import { isTrimmedLaunchGuidanceEnabled } from "../launch-guidance-settings.js";
import { isChatSurfaceEnabled } from "../chat-surface-settings.js";
import { errorMessage } from "../shared/lib/error-message.js";
import {
  beginArchive as beginArchiveImpl,
  executeArchive as executeArchiveImpl,
  type ArchiveDeps,
} from "./archive.js";
import { AgentError } from "./errors.js";
import {
  type AgentEventBus,
  type AgentEventHistoryListener,
  type AgentEventHistoryRow,
  createAgentEventBus,
  writeLatestEvent,
  writeLatestEventIfCurrent,
} from "./events.js";
import { runLifecycleHook } from "./lifecycle-hooks.js";
import {
  MAX_PINS,
  type PinSpec,
  applyPinSpec,
  applyPinSpecs,
  removePinGroup,
  removePinsByIds,
  replacePinGroup,
} from "./pin-write.js";
import {
  validatePinCaption,
  validatePinShortcutFields,
  validatePinValue,
} from "../pins.js";
import { diffPins, recordPinEvents } from "./pin-events.js";
import { type SeededMedia, seedInitialMedia } from "./media-seed.js";
import { type Reconciler, createReconciler } from "./reconciler.js";
import { type AgentRuntime, createAgentRuntime } from "./runtime.js";
import {
  buildStartupTurn,
  type ChatLaunchPost,
  shouldSuggestSessionRename,
} from "./launch-guidance.js";
import { prepareWorkspace } from "./workspace.js";
import { createAgentMcpToken, createJobMcpToken } from "../auth.js";
import type { DriverEvent } from "./acp/driver.js";
import { type EngineBins, isAcpEngine } from "./acp/engine-spec.js";
import { buildLaunchEnv } from "./acp/launch-env.js";
import { dispatchMcpUrl } from "./acp/mcp-url.js";
import { StreamRecorder } from "./acp/stream-recorder.js";
import { StreamStore } from "./acp/stream-store.js";
import { buildSystemPrompt } from "./acp/system-prompt.js";
import type {
  AgentGitContext,
  AgentLatestEventInput,
  AgentPin,
  AgentRecord,
  AgentRole,
  AgentStatus,
  AgentType,
  ArchivePhase,
  AgentEventListener,
  AgentTerminalAccess,
  SetupPhase,
  WorktreeCleanupMode,
  WorktreeStatus,
} from "./types.js";
import * as telemetry from "./telemetry.js";

export { AgentError } from "./errors.js";
export type {
  AgentEventListener,
  AgentGitContext,
  AgentPin,
  AgentRecord,
  AgentRole,
  AgentTerminalAccess,
  WorktreeStatus,
} from "./types.js";

const CODEX_FULL_ACCESS_ARG = "--dangerously-bypass-approvals-and-sandbox";
const CLAUDE_FULL_ACCESS_ARG = "--dangerously-skip-permissions";

/**
 * Validate + de-duplicate the `initialPins` array supplied to
 * `createAgent`. De-dup is case-insensitive on label with last-write-wins
 * semantics — same rule `upsertPin` applies for incremental adds. Throws
 * `AgentError(400)` when the de-duplicated count exceeds `MAX_PINS` so a
 * client can't bypass the quota by piling pins into the create payload.
 */
function normalizeInitialPins(pins: AgentPin[]): AgentPin[] {
  const byLabel = new Map<string, AgentPin>();
  for (const pin of pins) {
    // Seeding is the second write path into agents.pins; it has to accept the
    // same shapes as dispatch_pin, or a template could seed a pin the MCP tool
    // would have rejected — which now matters, since a shortcut's value is
    // delivered to a terminal rather than just displayed.
    try {
      validatePinValue(pin.type, pin.value);
      if (pin.caption !== undefined) validatePinCaption(pin.caption);
      if (pin.type === "shortcut") validatePinShortcutFields(pin);
    } catch (error) {
      // The validators throw plain Errors; surface them as 400s so a bad
      // initialPins payload reads as a client error rather than a crash.
      throw new AgentError(errorMessage(error), 400);
    }

    byLabel.set(pin.label.toLowerCase(), {
      ...pin,
      id: pin.id ?? randomUUID(),
    });
  }
  const deduped = Array.from(byLabel.values());
  if (deduped.length > MAX_PINS) {
    throw new AgentError(
      `Cannot seed agent with more than ${MAX_PINS} initial pins (got ${deduped.length} after de-duplication).`,
      400
    );
  }
  return deduped;
}

type WorktreeLocation = "sibling" | "nested";

type CreateAgentInput = {
  name?: string;
  type?: AgentType;
  role?: AgentRole;
  cwd: string;
  agentArgs?: string[];
  model?: string;
  fullAccess?: boolean;
  useWorktree?: boolean;
  /**
   * When true (default), create a new branch for the worktree from
   * `baseBranch`. When false, check out `baseBranch` directly without
   * creating a new branch.
   */
  createNewBranch?: boolean;
  worktreeBranch?: string;
  baseBranch?: string;
  worktreeLocation?: WorktreeLocation;
  persona?: string;
  parentAgentId?: string;
  /** Launcher of this agent, recorded even when it is not the parent. */
  launchedByAgentId?: string;
  personaContext?: string;
  reviewAgentType?: AgentType | null;
  autoReview?: boolean;
  cliSessionId?: string;
  jobRunId?: string;
  initialPrompt?: string;
  /**
   * What the Chat feed shows as the launch context, when it differs from
   * what the CLI receives: `prompt` is the message as the person or launching
   * agent wrote it (the MCP launch path wraps `initialPrompt` in a header the
   * feed should not repeat); `links` are the raw startup URLs the route also
   * turned into url pins. Internal/generated startup prompts are deliberately
   * omitted unless a caller explicitly supplies their user-authored context.
   */
  launchContext?: {
    prompt?: string;
    links?: string[];
  };
  initialPins?: AgentPin[];
  initialFiles?: Array<{
    fileName: string;
    originalName?: string;
    buffer: Buffer;
    source: "text" | "user";
    description?: string | null;
  }>;
  templateId?: string;
};

type StopAgentInput = {
  force?: boolean;
};

type PreparedCreateInputs = {
  id: string;
  type: AgentType;
  role: AgentRole;
  name: string;
  originalCwd: string;
  mediaDir: string;
  agentArgs: string[];
  model: string | undefined;
  fullAccess: boolean;
  initialPins: AgentPin[];
  useWorktree: boolean;
  createNewBranch: boolean;
  normalizedBaseBranch: string | undefined;
  worktreeBranchName: string | undefined;
  worktreePathOverride: string | undefined;
  cliSessionId: string | null;
  initialSetupPhase: SetupPhase;
};

/**
 * Subset of `DiffStatsRefresher` the manager calls into. Defined as a
 * narrow interface so the manager doesn't import the refresher class
 * directly — keeps the refresher's wiring at the server-composition level.
 */
export type DiffStatsRefresherHandle = {
  signal: (agentId: string) => Promise<void>;
  clear: (agentId: string) => void;
};

/**
 * Records what an agent was launched with as the first post of its Chat
 * feed. Implemented by `ChatService.prepareLaunchContext`; narrowed so the
 * manager never imports the chat module. `prepare` resolves the post (its
 * attachments and their envelope lines) without writing it, so the CLI's
 * first turn can be built from the same id and lines; `record` then writes
 * it. Null means the launch carries no context and nothing is recorded.
 */
export type LaunchContextInput = {
  id: string;
  agentId: string;
  text?: string;
  files?: Array<{ mediaId: number }>;
  links?: string[];
  pins?: Array<{ id: string; type: string; value: string }>;
  launchedByAgentId?: string | null;
};

export type LaunchContextRecorder = {
  prepareLaunchContext: (input: LaunchContextInput) => Promise<{
    /**
     * Every startup file, link and pin, described the way the pane lists
     * them. Not capped: the post may show fewer, but the CLI's first turn
     * has to name all of the context the agent was launched with.
     */
    attachmentLines: string[];
    /** Rejects when the post was not written, including an id collision. */
    record: () => Promise<unknown>;
  } | null>;
};

/** The two settings-backed switches the launch guidance is built from. */
async function readLaunchGuidanceFlags(
  pool: Pool
): Promise<{ trimmedGuidance: boolean; chatSurface: boolean }> {
  const [trimmedGuidance, chatSurface] = await Promise.all([
    isTrimmedLaunchGuidanceEnabled(pool),
    isChatSurfaceEnabled(pool),
  ]);
  return { trimmedGuidance, chatSurface };
}

/** Upper bound on how long a launch waits for its Chat launch post. */
export const LAUNCH_CONTEXT_WRITE_TIMEOUT_MS = 5_000;

/**
 * Upper bound on resolving the launch post before the CLI command is built.
 * Unlike the write, this one is on the launch's critical path — the first
 * turn's envelope needs the post's id and attachment lines — so a slow or
 * hung Chat read gives up and the agent launches with the plain startup
 * prompt and no post, rather than the two disagreeing.
 */
export const LAUNCH_CONTEXT_RESOLVE_TIMEOUT_MS = 5_000;

/** Sentinel for a promise that outlived its bound. */
const TIMED_OUT = Symbol("timed-out");

/** Resolve with the promise's value, or `TIMED_OUT` after `ms`. */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number
): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class AgentManager {
  private readonly pool: Pool;
  private readonly logger: FastifyBaseLogger;
  private readonly config: AppConfig;
  private readonly diagnostics: DiagnosticsRecorder;
  private readonly eventBus: AgentEventBus;
  private readonly runtime: AgentRuntime;
  private readonly reconciler: Reconciler;
  private readonly streamStore: StreamStore;
  private readonly streamRecorder: StreamRecorder;
  /** Listeners told after the stream changed for an agent (coalesced). */
  private readonly streamWriteListeners: Array<(agentId: string) => void> = [];
  private readonly streamPublishTimers = new Map<string, NodeJS.Timeout>();
  private diffStatsRefresher: DiffStatsRefresherHandle | null = null;
  private launchContextRecorder: LaunchContextRecorder | null = null;
  private readonly agentCreatedListeners: Array<(agent: AgentRecord) => void> =
    [];
  private readonly eventRecordedListeners: AgentEventHistoryListener[] = [];

  constructor(
    pool: Pool,
    logger: FastifyBaseLogger,
    config: AppConfig,
    /** Tests inject a fake runtime; the server takes the configured one. */
    options: { runtime?: AgentRuntime } = {}
  ) {
    this.pool = pool;
    this.logger = logger;
    this.config = config;
    this.diagnostics = createDiagnosticsRecorder(logger);
    this.eventBus = createAgentEventBus(logger);
    this.streamStore = new StreamStore(pool);
    this.streamRecorder = new StreamRecorder(this.streamStore);
    this.runtime =
      options.runtime ??
      createAgentRuntime(config, logger, {
        hostSeq: async (agentId) => {
          const result = await pool.query<{ host_seq: number }>(
            "SELECT host_seq FROM agents WHERE id = $1",
            [agentId]
          );
          return result.rows[0]?.host_seq ?? 0;
        },
      });
    this.runtime.onEvent((agentId, event, seq) =>
      this.handleRuntimeEvent(agentId, event, seq)
    );
    this.reconciler = createReconciler({
      pool,
      logger,
      runtime: this.runtime,
      diagnostics: this.diagnostics,
      getAgent: (id) => this.getAgent(id),
      setAgentStatus: (id, status, lastError) =>
        this.setAgentStatus(id, status, lastError),
      setSystemLatestEvent: (id, input) => this.setSystemLatestEvent(id, input),
      settleStream: (id, reason) => this.streamStore.settleInterrupted(id, reason),
    });
  }

  /** Register a callback told, coalesced, whenever an agent's stream changed. */
  onStreamWrite(listener: (agentId: string) => void): void {
    this.streamWriteListeners.push(listener);
  }

  private notifyStreamWrite(agentId: string, immediate: boolean): void {
    const fire = () => {
      this.streamPublishTimers.delete(agentId);
      for (const listener of this.streamWriteListeners) {
        try {
          listener(agentId);
        } catch (err) {
          this.logger.warn({ err, agentId }, "stream write listener failed");
        }
      }
    };
    const pending = this.streamPublishTimers.get(agentId);
    if (immediate) {
      if (pending) clearTimeout(pending);
      fire();
      return;
    }
    if (pending) return;
    const timer = setTimeout(fire, 100);
    timer.unref?.();
    this.streamPublishTimers.set(agentId, timer);
  }

  /**
   * One event from an agent's host, in seq order. Folded into the stream
   * rows, then the replay watermark moves; seq 0 is an event the runtime
   * made up for a host that vanished and never moves the watermark.
   */
  private async handleRuntimeEvent(
    agentId: string,
    event: DriverEvent,
    seq: number
  ): Promise<void> {
    await this.streamRecorder.handle(event);
    if (seq > 0) {
      await this.pool.query(
        "UPDATE agents SET host_seq = GREATEST(host_seq, $2) WHERE id = $1",
        [agentId, seq]
      );
    }
    if (event.type === "exit" && !event.expected) {
      const how =
        event.code === null
          ? event.signal
            ? `on signal ${event.signal}`
            : "unexpectedly"
          : `with code ${event.code}`;
      const tail = event.stderrTail ? `: ${event.stderrTail}` : "";
      await this.markHostExited(agentId, `The agent exited ${how}${tail}`);
    }
    this.notifyStreamWrite(
      agentId,
      event.type === "turn" || event.type === "exit"
    );
  }

  /** The engine or its host died on its own: the agent cannot stay running. */
  private async markHostExited(agentId: string, message: string): Promise<void> {
    const agent = await this.getAgent(agentId);
    if (!agent || agent.status !== "running") return;
    await this.setAgentStatus(agentId, "error", message.slice(0, 1000));
    await this.setSystemLatestEvent(agentId, {
      type: "blocked",
      message: message.slice(0, 200),
      metadata: { source: "system", phase: "exit" },
    });
    this.eventBus.publish(await this.getRequiredAgent(agentId));
  }

  /**
   * Where a prompt for this agent goes. `live` when its host is up; `inert`
   * when the runtime has no processes at all (e2e), which callers treat as
   * "record it, nothing to deliver to".
   */
  async getTerminalAccess(id: string): Promise<AgentTerminalAccess> {
    const agent = await this.getRequiredAgent(id);
    if (agent.status !== "running" && agent.status !== "creating") {
      throw new AgentError("Agent is not running.", 409);
    }
    if (!this.runtime.tracksProcesses()) {
      return {
        mode: "inert",
        message:
          "Agent is running in inert mode. No engine process is attached in this environment.",
      };
    }
    if (!(await this.runtime.isAlive(id))) {
      await this.setAgentStatus(id, "stopped", "The agent host is no longer running.");
      throw new AgentError(
        "Agent session is not available. Start the agent again.",
        409
      );
    }
    return { mode: "live" };
  }

  /** Queue one turn; see AgentRuntime.prompt. */
  promptAgent(
    id: string,
    text: string
  ): { accepted: Promise<void>; settled: Promise<void> } {
    return this.runtime.prompt(id, text);
  }

  /** A turn is running or prompts are waiting behind one. */
  isPromptHeld(id: string): boolean {
    return this.runtime.isBusy(id);
  }

  /** Cancel the running turn (Stop). */
  async cancelTurn(id: string): Promise<void> {
    await this.runtime.cancel(id);
  }

  private sendPromptDetached(id: string, text: string, what: string): void {
    const { accepted, settled } = this.runtime.prompt(id, text);
    accepted.catch((err: unknown) =>
      this.logger.warn({ err, agentId: id }, `${what} was not accepted`)
    );
    settled.catch((err: unknown) =>
      this.logger.warn({ err, agentId: id }, `${what} failed`)
    );
  }

  /**
   * At boot: reconnect to every host that outlived the last server process.
   * An agent whose host is gone is marked stopped rather than left "running"
   * with nothing behind it.
   */
  async restoreRunningAgents(): Promise<{ attached: string[]; lost: string[] }> {
    const attached: string[] = [];
    const lost: string[] = [];
    const result = await this.pool.query<{ id: string; cwd: string }>(
      `SELECT id, cwd FROM agents
        WHERE status IN ('running', 'creating') AND deleted_at IS NULL
        ORDER BY created_at`
    );
    for (const row of result.rows) {
      this.streamRecorder.setCwd(row.id, row.cwd);
      if (await this.runtime.attach(row.id)) {
        attached.push(row.id);
        continue;
      }
      lost.push(row.id);
      await this.streamStore.settleInterrupted(
        row.id,
        "the agent was not running when Dispatch restarted"
      );
      await this.setAgentStatus(
        row.id,
        "stopped",
        "The agent host was not running when Dispatch restarted."
      );
      await this.setSystemLatestEvent(row.id, {
        type: "idle",
        message: "Session ended while Dispatch was down.",
        metadata: { source: "system" },
      });
    }
    if (attached.length || lost.length) {
      this.logger.info({ attached, lost }, "Restored running agents");
    }
    return { attached, lost };
  }

  /** Register a callback invoked after every upsertLatestEvent. */
  onLatestEvent(listener: AgentEventListener): void {
    this.eventBus.subscribe(listener);
  }

  /** Register a callback invoked immediately after an agent record is INSERTed. */
  onAgentCreated(listener: (agent: AgentRecord) => void): void {
    this.agentCreatedListeners.push(listener);
  }

  /**
   * Register a callback invoked with each `agent_events` history row as it
   * is written — after the latest-event update, off its critical path.
   */
  onEventRecorded(listener: AgentEventHistoryListener): void {
    this.eventRecordedListeners.push(listener);
  }

  private readonly notifyEventRecorded = (row: AgentEventHistoryRow): void => {
    for (const listener of this.eventRecordedListeners) {
      try {
        listener(row);
      } catch (err) {
        this.logger.warn({ err }, "agent event history listener threw");
      }
    }
  };

  /**
   * Inject the diff-stats refresher singleton. Wired post-construction so
   * the manager and refresher can each take a reference to the other
   * without a circular constructor dance.
   */
  attachDiffStatsRefresher(refresher: DiffStatsRefresherHandle): void {
    this.diffStatsRefresher = refresher;
  }

  /**
   * Inject the Chat feed's launch-context recorder. Wired post-construction
   * because the chat service reads agents through this manager.
   */
  attachLaunchContextRecorder(recorder: LaunchContextRecorder): void {
    this.launchContextRecorder = recorder;
  }

  async listAgents(): Promise<AgentRecord[]> {
    const result = await this.pool.query(
      `${this.baseAgentSelectSql()} ORDER BY created_at DESC`
    );
    return result.rows as AgentRecord[];
  }

  async getAgent(id: string): Promise<AgentRecord | null> {
    const result = await this.pool.query(
      `${this.baseAgentSelectSql()} AND id = $1`,
      [id]
    );
    return (result.rows[0] as AgentRecord | undefined) ?? null;
  }

  async renameAgent(id: string, name: string): Promise<AgentRecord> {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new AgentError("Agent name must not be empty.", 400);
    }

    await this.getRequiredAgent(id);
    await this.pool.query(
      `UPDATE agents SET name = $2, updated_at = NOW() WHERE id = $1`,
      [id, trimmed]
    );
    return (await this.getAgent(id)) as AgentRecord;
  }

  /**
   * Populate `git_context` for an agent at lifecycle boundaries (creation,
   * setup-complete, restart). For dispatch-managed worktrees we already
   * know the branch + path from row columns and only need a single git
   * call to resolve the parent repo root; for other agents (no
   * `worktree_path`) we run a full probe against `cwd`. Probe failures
   * are logged and persisted as `stale = true` so the existing value
   * (if any) stays visible in the UI rather than disappearing.
   */
  async populateGitContext(id: string): Promise<void> {
    const agent = await this.getAgent(id);
    if (!agent) return;

    const result =
      agent.worktreePath && agent.worktreeBranch
        ? await buildGitContextForWorktree({
            worktreePath: agent.worktreePath,
            worktreeBranch: agent.worktreeBranch,
          })
        : await probeGitContext(agent.cwd);

    if (result.status === "error") {
      this.logger.warn(
        { agentId: id },
        "Git context probe failed; marking stale and continuing."
      );
      await this.pool.query(
        `UPDATE agents SET git_context_stale = true, git_context_updated_at = NOW() WHERE id = $1`,
        [id]
      );
      return;
    }

    await this.pool.query(
      `
      UPDATE agents
      SET git_context = $2::jsonb,
          git_context_stale = false,
          git_context_updated_at = NOW()
      WHERE id = $1
      `,
      [id, result.value ? JSON.stringify(result.value) : null]
    );
  }

  async createAgent(input: CreateAgentInput): Promise<AgentRecord> {
    const p = await this.prepareCreateInputs(input);
    await this.insertAgentRecord(p, input);

    const createdAgent = await this.getAgent(p.id);
    if (createdAgent) {
      for (const listener of this.agentCreatedListeners) {
        try {
          listener(createdAgent);
        } catch {
          /* listener errors must not break creation */
        }
      }
    }

    let initialMedia: SeededMedia[] = [];
    if (input.initialFiles && input.initialFiles.length > 0) {
      try {
        initialMedia = await seedInitialMedia(
          this.pool,
          p.id,
          p.mediaDir,
          input.initialFiles
        );
      } catch (error) {
        await this.pool
          .query("DELETE FROM agents WHERE id = $1", [p.id])
          .catch(() => {});
        await rm(p.mediaDir, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
    }
    // The settings read is on the create path ahead of the launch's own
    // try/catch, so a rejecting query would otherwise leave the row stuck in
    // `creating`. Route it through the same failure handling the launch uses.
    const launchGuidanceFlags = input.jobRunId
      ? { trimmedGuidance: false, chatSurface: false }
      : await readLaunchGuidanceFlags(this.pool).catch((error: unknown) =>
          this.failCreate(p.id, error)
        );
    // The launch post is the first turn's envelope, so a launch that carries
    // a prompt waits for the post to be durable before the engine starts.
    // Job runs keep Chat quiet; their prompt goes as the first turn as-is.
    const recorder = this.launchContextRecorder;
    const wantsEnvelope = recorder !== null && !input.jobRunId;
    const launchPostId = randomUUID();
    const launchContextInput = recorder
      ? this.launchContextInput(p, input, initialMedia, launchPostId)
      : null;
    let chatLaunchPost: ChatLaunchPost | null = null;
    let launchContextWrite: Promise<void> = Promise.resolve();
    if (recorder && launchContextInput) {
      if (wantsEnvelope) {
        chatLaunchPost = await this.resolveDurableLaunchPost(
          recorder,
          p.id,
          launchPostId,
          launchContextInput
        );
      } else {
        launchContextWrite = this.recordLaunchContextDetached(
          recorder,
          p.id,
          launchContextInput
        );
      }
    }

    await this.launchAgent({
      id: p.id,
      name: p.name,
      originalCwd: p.originalCwd,
      useWorktree: p.useWorktree,
      createNewBranch: p.createNewBranch,
      worktreeBranchName: p.worktreeBranchName,
      normalizedBaseBranch: p.normalizedBaseBranch,
      worktreePathOverride: p.worktreePathOverride,
      initialPrompt: input.initialPrompt,
      initialPins: p.initialPins,
      initialMedia,
      chatLaunchPost,
      launchGuidanceFlags,
      jobRunId: input.jobRunId,
    });

    await launchContextWrite;
    return (await this.getAgent(p.id)) as AgentRecord;
  }

  /**
   * The launch context as the recorder wants it, built once so the critical
   * path and the detached path cannot describe the same launch differently.
   *
   * Only an explicit `launchedByAgentId` attributes the post to an agent —
   * the agent-authenticated launch paths set it. `parentAgentId` is never
   * used for attribution: the create route accepts it from the request body.
   */
  private launchContextInput(
    p: PreparedCreateInputs,
    input: CreateAgentInput,
    initialMedia: Array<{ mediaId: number }>,
    launchPostId: string
  ): LaunchContextInput {
    return {
      id: launchPostId,
      agentId: p.id,
      text: input.launchContext?.prompt,
      files: initialMedia.map((media) => ({ mediaId: media.mediaId })),
      links: input.launchContext?.links ?? [],
      pins: p.initialPins.map((pin) => ({
        id: pin.id ?? "",
        type: pin.type,
        value: pin.value,
      })),
      launchedByAgentId: input.launchedByAgentId ?? null,
    };
  }

  /**
   * Resolve *and* write the launch post before the CLI command is built,
   * for the one case where the first turn will name it.
   *
   * An envelope naming a row that does not exist points the agent's replies
   * at nothing, so a durable insert is the precondition for using one: the
   * resolve and the write are each awaited under their own bound, and
   * anything short of a written row — a rejection, a timeout, an id already
   * taken — returns null and the agent launches with the plain startup
   * prompt and no post. That pair can never disagree. A write that lands
   * after its bound still lands; it is simply not named in the first turn.
   */
  private async resolveDurableLaunchPost(
    recorder: LaunchContextRecorder,
    agentId: string,
    launchPostId: string,
    context: LaunchContextInput
  ): Promise<ChatLaunchPost | null> {
    const resolve = recorder
      .prepareLaunchContext(context)
      .catch((error: unknown) => {
        this.logger.warn(
          { err: error, agentId },
          "chat: failed to resolve launch context; launching without it"
        );
        return null;
      });
    const prepared = await withTimeout(
      resolve,
      LAUNCH_CONTEXT_RESOLVE_TIMEOUT_MS
    );
    if (prepared === TIMED_OUT) {
      this.logger.warn(
        { agentId, timeoutMs: LAUNCH_CONTEXT_RESOLVE_TIMEOUT_MS },
        "chat: launch context did not resolve in time; launching without it"
      );
      return null;
    }
    if (!prepared) return null;
    const write = Promise.resolve()
      .then(() => prepared.record())
      .then(
        () => true,
        (error: unknown) => {
          this.logger.warn(
            { err: error, agentId },
            "chat: failed to record launch context; launching without the Chat envelope"
          );
          return false;
        }
      );
    const written = await withTimeout(write, LAUNCH_CONTEXT_WRITE_TIMEOUT_MS);
    if (written === TIMED_OUT) {
      this.logger.warn(
        { agentId, timeoutMs: LAUNCH_CONTEXT_WRITE_TIMEOUT_MS },
        "chat: launch post was not written in time; launching without the Chat envelope"
      );
      return null;
    }
    if (!written) return null;
    return {
      messageId: launchPostId,
      attachmentLines: prepared.attachmentLines,
    };
  }

  /**
   * Put the launch context at the top of the Chat feed without holding the
   * launch, for every launch whose first turn will not name it: the flag
   * off, a job run, or an inert runtime. Resolving and writing both run
   * alongside the runtime start, a failure is logged and never fails the
   * launch (the prompt still reaches the CLI), and the returned promise
   * settles after at most `LAUNCH_CONTEXT_WRITE_TIMEOUT_MS` so a slow or
   * hung Chat write cannot hold the agent start. A write that outlives the
   * wait still lands (and announces itself) whenever it completes.
   */
  private recordLaunchContextDetached(
    recorder: LaunchContextRecorder,
    agentId: string,
    context: LaunchContextInput
  ): Promise<void> {
    const write = Promise.resolve()
      .then(async () => {
        const prepared = await recorder.prepareLaunchContext(context);
        if (prepared) await prepared.record();
      })
      .then(
        () => "written" as const,
        (error: unknown) => {
          this.logger.warn(
            { err: error, agentId },
            "chat: failed to record launch context"
          );
          return "failed" as const;
        }
      );
    return withTimeout(write, LAUNCH_CONTEXT_WRITE_TIMEOUT_MS).then(
      (outcome) => {
        if (outcome === TIMED_OUT) {
          this.logger.warn(
            { agentId, timeoutMs: LAUNCH_CONTEXT_WRITE_TIMEOUT_MS },
            "chat: launch context write still pending; launch continues without it"
          );
        }
      }
    );
  }

  private async prepareCreateInputs(
    input: CreateAgentInput
  ): Promise<PreparedCreateInputs> {
    const originalCwd = await this.validateWorkingDirectory(input.cwd);
    const id = this.newAgentId();
    const type: AgentType = input.type ?? "codex";
    const role: AgentRole = input.role ?? "standard";
    const fullAccess = input.fullAccess ?? false;
    const fullAccessArg =
      type === "claude"
        ? CLAUDE_FULL_ACCESS_ARG
        : type === "codex"
          ? CODEX_FULL_ACCESS_ARG
          : null;
    const agentArgs =
      fullAccess && fullAccessArg
        ? Array.from(new Set([...(input.agentArgs ?? []), fullAccessArg]))
        : (input.agentArgs ?? []);
    const name = input.name?.trim() || `agent-${id.slice(-6)}`;
    const mediaDir = path.join(this.config.mediaRoot, id);
    await mkdir(mediaDir, { recursive: true });
    // Cap + de-dup pins so the create endpoint can't bypass the upsertPin
    // quota or bloat the startup prompt (pins flow into buildStartupPrompt).
    const initialPins = normalizeInitialPins(input.initialPins ?? []);

    const useWorktree = input.useWorktree !== false;
    const createNewBranch = input.createNewBranch ?? true;

    // Sanitize ref names: rejects chars that would allow injection in the
    // bash setup script and gives us a canonical form for archive cleanup.
    let normalizedBaseBranch: string | undefined;
    let normalizedWorktreeBranch: string | undefined;
    try {
      if (input.baseBranch !== undefined && input.baseBranch.trim() !== "") {
        normalizedBaseBranch = assertSafeRefName(
          input.baseBranch,
          "baseBranch"
        );
      }
      if (
        input.worktreeBranch !== undefined &&
        input.worktreeBranch.trim() !== ""
      ) {
        normalizedWorktreeBranch = assertSafeRefName(
          input.worktreeBranch,
          "worktreeBranch"
        );
      }
    } catch (err) {
      if (err instanceof GitWorktreeError) {
        throw new AgentError(err.message, err.statusCode);
      }
      throw err;
    }
    if (useWorktree) {
      normalizedBaseBranch = normalizedBaseBranch ?? "main";
    }

    let worktreeBranchName: string | undefined;
    let worktreePathOverride: string | undefined;
    if (useWorktree) {
      if (createNewBranch) {
        const slugName = name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "");
        worktreeBranchName =
          normalizedWorktreeBranch || `${id}/${slugName || "work"}`;
      } else {
        worktreeBranchName = normalizedBaseBranch || "main";
      }
      const worktreeLocation = input.worktreeLocation ?? "sibling";
      if (worktreeLocation === "nested") {
        worktreePathOverride = path.join(
          originalCwd,
          ".dispatch",
          "worktrees",
          worktreePathSlug(worktreeBranchName, { createNewBranch })
        );
      }
    }

    // The engine mints the ACP session id at launch; a caller-supplied one
    // is a session to resume.
    const cliSessionId = input.cliSessionId ?? null;
    const initialSetupPhase: SetupPhase = useWorktree ? "worktree" : "session";

    return {
      id,
      type,
      role,
      name,
      originalCwd,
      mediaDir,
      agentArgs,
      model: input.model,
      fullAccess,
      initialPins,
      useWorktree,
      createNewBranch,
      normalizedBaseBranch,
      worktreeBranchName,
      worktreePathOverride,
      cliSessionId,
      initialSetupPhase,
    };
  }

  private async insertAgentRecord(
    p: PreparedCreateInputs,
    input: CreateAgentInput
  ): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO agents (id, name, type, role, status, cwd, media_dir, codex_args, model, full_access, setup_phase, persona, parent_agent_id, launched_by_agent_id, persona_context, review_agent_type, cli_session_id, auto_review, base_branch, template_id, pins, updated_at)
      VALUES ($1, $2, $3, $4, 'creating', $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb, NOW())
      `,
      [
        p.id,
        p.name,
        p.type,
        p.role,
        p.originalCwd,
        p.mediaDir,
        JSON.stringify(p.agentArgs),
        p.model ?? null,
        p.fullAccess,
        p.initialSetupPhase,
        input.persona ?? null,
        input.parentAgentId ?? null,
        input.launchedByAgentId ?? input.parentAgentId ?? null,
        input.personaContext ?? null,
        input.reviewAgentType ?? null,
        p.cliSessionId,
        input.autoReview ?? false,
        p.normalizedBaseBranch ?? null,
        input.templateId ?? null,
        JSON.stringify(p.initialPins),
      ]
    );
  }

  /**
   * Create the workspace, start the host, and send the first turn. Every
   * rejection lands in `failCreate` so the row never sticks in `creating`.
   */
  private async launchAgent(opts: {
    id: string;
    name: string;
    originalCwd: string;
    useWorktree: boolean;
    createNewBranch: boolean;
    worktreeBranchName: string | undefined;
    normalizedBaseBranch: string | undefined;
    worktreePathOverride: string | undefined;
    initialPrompt: string | undefined;
    initialPins: AgentPin[];
    initialMedia: SeededMedia[];
    chatLaunchPost: ChatLaunchPost | null;
    launchGuidanceFlags: { trimmedGuidance: boolean; chatSurface: boolean };
    jobRunId: string | undefined;
  }): Promise<void> {
    const { id } = opts;
    try {
      const workspace = await prepareWorkspace(
        {
          agentName: opts.name,
          originalCwd: opts.originalCwd,
          useWorktree: opts.useWorktree,
          createNewBranch: opts.createNewBranch,
          worktreeBranchName: opts.worktreeBranchName,
          baseBranch: opts.normalizedBaseBranch,
          worktreePathOverride: opts.worktreePathOverride,
          onPhase: (phase) => this.setSetupPhase(id, phase),
        },
        this.logger
      );
      await this.pool.query(
        `UPDATE agents SET cwd = $2, worktree_path = $3, worktree_branch = $4, updated_at = NOW() WHERE id = $1`,
        [
          id,
          workspace.effectiveCwd,
          workspace.worktreePath,
          workspace.worktreeBranch,
        ]
      );
      const agent = await this.getRequiredAgent(id);
      const { sessionId } = await this.startHost(agent, {
        resumeSessionId: null,
        jobRunId: opts.jobRunId,
        trimmedGuidance: opts.launchGuidanceFlags.trimmedGuidance,
      });
      await this.pool.query(
        `UPDATE agents SET status = 'running', cli_session_id = $2, setup_phase = NULL, updated_at = NOW() WHERE id = $1`,
        [id, sessionId]
      );
      await this.populateGitContext(id);
      await this.setSystemLatestEvent(id, {
        type: "idle",
        message: "Session started.",
      });
      const firstTurn = buildStartupTurn(
        {
          initialPrompt: opts.initialPrompt,
          initialPins: opts.initialPins,
          initialMedia: opts.initialMedia,
          chatLaunchPost: opts.chatLaunchPost,
        },
        { chatSurface: true, jobRunId: opts.jobRunId }
      );
      if (firstTurn) this.sendPromptDetached(id, firstTurn, "first turn");
    } catch (error) {
      if (error instanceof GitWorktreeError) {
        const lastError = `Worktree creation failed: ${error.message}`;
        await this.setAgentStatus(id, "stopped", lastError);
        await this.setSetupPhase(id, null);
        await this.setSystemLatestEvent(id, { type: "blocked", message: lastError });
        throw new AgentError(lastError, error.statusCode);
      }
      await this.failCreate(id, error);
    }
  }

  /**
   * Start (or resume) the agent's host. Builds everything the engine needs
   * (system prompt, MCP credentials, environment) from the agent record and
   * the settings, and hands it to the runtime.
   */
  private async startHost(
    agent: AgentRecord,
    opts: {
      resumeSessionId: string | null;
      jobRunId: string | undefined;
      trimmedGuidance?: boolean;
    }
  ): Promise<{ sessionId: string; resumed: boolean }> {
    if (!isAcpEngine(agent.type)) {
      throw new AgentError(
        `Agent type "${agent.type}" is not supported by the ACP runtime.`,
        400
      );
    }
    const mediaDir = resolveMediaDir(
      agent.id,
      agent.mediaDir,
      this.config.mediaRoot
    );
    await mkdir(mediaDir, { recursive: true });
    const personality =
      agent.persona || opts.jobRunId || agent.role === "assisted_update"
        ? null
        : await getActivePersonality(this.pool);
    const trimmedGuidance =
      opts.trimmedGuidance ?? (await isTrimmedLaunchGuidanceEnabled(this.pool));
    const systemPrompt = buildSystemPrompt({
      agent,
      personalityPrompt: personality?.prompt ?? null,
      trimmedGuidance,
      suggestSessionRename: shouldSuggestSessionRename(agent.name, agent.id, {
        persona: agent.persona,
        jobRunId: opts.jobRunId,
      }),
      jobRunId: opts.jobRunId ?? null,
    });
    const { env, pathPrefix } = buildLaunchEnv({
      agentId: agent.id,
      mediaDir,
      engine: agent.type,
      config: this.config,
    });
    const bins: EngineBins = {
      claudeAdapterBin: this.config.claudeAdapterBin,
      claudeBin: this.config.claudeBin,
      codexAdapterBin: this.config.codexAdapterBin,
      codexBin: this.config.codexBin,
    };
    this.streamRecorder.setCwd(agent.id, agent.cwd);
    // Rows a previous host left open (a crash mid-turn) settle first, so the
    // feed never shows a turn that can no longer finish.
    await this.streamRecorder.reconcile(agent.id);
    const token = opts.jobRunId
      ? createJobMcpToken(this.config.authToken, opts.jobRunId, agent.id)
      : createAgentMcpToken(this.config.authToken, agent.id);
    return this.runtime.launch({
      agentId: agent.id,
      cwd: agent.cwd,
      engine: agent.type,
      bins,
      systemPrompt,
      mcp: {
        url: dispatchMcpUrl(this.config, agent.id, opts.jobRunId),
        token,
      },
      env,
      pathPrefix,
      resumeSessionId: opts.resumeSessionId,
    });
  }

  /**
   * Put a half-created agent into its terminal failure state and rethrow.
   *
   * Anything on the create path that can reject has to land here: the row is
   * already inserted as `creating`, so an escaping error would strand it in
   * that state with a stale setup phase and no event explaining why.
   */
  private async failCreate(id: string, error: unknown): Promise<never> {
    const message = errorMessage(error);
    await this.setAgentStatus(id, "error", message);
    await this.setSetupPhase(id, null);
    await this.setSystemLatestEvent(id, {
      type: "blocked",
      message: `Failed to create agent: ${message}`,
      metadata: { source: "system", phase: "create" },
    });
    throw new AgentError(`Failed to create agent: ${message}`, 500);
  }

  async updateSetupPhase(id: string, phase: SetupPhase): Promise<void> {
    await this.setSetupPhase(id, phase);
  }

  async updateReviewAgentType(
    id: string,
    reviewAgentType: AgentType | null
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE agents SET review_agent_type = $2, updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL`,
      [id, reviewAgentType]
    );
    if (result.rowCount === 0) {
      throw new AgentError("Agent not found.", 404);
    }
  }

  async startAgent(id: string): Promise<AgentRecord> {
    const agent = await this.getRequiredAgent(id);
    if (await this.runtime.attach(id)) {
      this.streamRecorder.setCwd(id, agent.cwd);
      await this.setAgentStatus(id, "running", null);
      await this.setSystemLatestEvent(id, {
        type: "idle",
        message: "Reattached to the running agent.",
      });
      return (await this.getAgent(id)) as AgentRecord;
    }

    await this.setAgentStatus(id, "creating", null);
    try {
      const { sessionId, resumed } = await this.startHost(agent, {
        resumeSessionId: agent.cliSessionId ?? null,
        jobRunId: undefined,
      });
      await this.pool.query(
        `UPDATE agents SET status = 'running', cli_session_id = $2, last_error = NULL, updated_at = NOW() WHERE id = $1`,
        [id, sessionId]
      );
      // Re-populate gitContext on every restart so drift from external git
      // activity gets picked up at start time.
      await this.populateGitContext(id);
      await this.setSystemLatestEvent(id, {
        type: "idle",
        message: resumed ? "Session resumed." : "Session started.",
      });
    } catch (error) {
      const message = errorMessage(error);
      await this.setAgentStatus(id, "error", message);
      await this.setSystemLatestEvent(id, {
        type: "blocked",
        message: `Failed to start agent: ${message}`,
        metadata: { source: "system", phase: "start" },
      });
      throw new AgentError(`Failed to start agent: ${message}`, 500);
    }

    return (await this.getAgent(id)) as AgentRecord;
  }

  async stopAgent(
    id: string,
    input: StopAgentInput = {}
  ): Promise<AgentRecord> {
    const agent = await this.getRequiredAgent(id);
    const force = input.force ?? false;

    if (agent.status === "stopped") {
      return agent;
    }

    await this.setAgentStatus(id, "stopping", null);

    // Run repo-defined stop hook (best-effort, non-blocking)
    await runLifecycleHook("stop", agent, this.logger).catch((err) =>
      this.logger.warn(
        { err, agentId: id },
        "Stop hook failed; continuing shutdown"
      )
    );

    try {
      await this.runtime.stop(id, force);
      await this.streamStore.settleInterrupted(id, "stopped");
      await this.setAgentStatus(id, "stopped", null);
      await this.setSystemLatestEvent(id, {
        type: "idle",
        message: "Session stopped.",
      });
      this.notifyStreamWrite(id, true);
    } catch (error) {
      const message = errorMessage(error);
      await this.setAgentStatus(id, "error", message);
      await this.setSystemLatestEvent(id, {
        type: "blocked",
        message: `Failed to stop agent: ${message}`,
        metadata: { source: "system", phase: "stop" },
      });
      throw new AgentError(`Failed to stop agent: ${message}`, 500);
    }

    return (await this.getAgent(id)) as AgentRecord;
  }

  async beginArchive(
    id: string,
    cleanupWorktree: WorktreeCleanupMode = "auto"
  ): Promise<AgentRecord> {
    return beginArchiveImpl(this.archiveDeps(), id, cleanupWorktree);
  }

  async executeArchive(
    id: string,
    callbacks: {
      onPhaseChange: (agent: AgentRecord) => void;
      onComplete: (deletedIds: string[]) => void;
      onError: (error: unknown) => void;
    }
  ): Promise<void> {
    return executeArchiveImpl(this.archiveDeps(), id, callbacks);
  }

  async checkWorktreeStatus(id: string): Promise<WorktreeStatus> {
    const agent = await this.getRequiredAgent(id);

    if (!agent.worktreePath) {
      return {
        hasWorktree: false,
        hasUnmergedCommits: false,
        hasUncommittedChanges: false,
        worktreePath: null,
        branchName: null,
        changedFiles: [],
        uncommittedFiles: [],
      };
    }

    return readWorktreeStatus(agent.worktreePath);
  }

  async upsertLatestEvent(
    id: string,
    input: AgentLatestEventInput
  ): Promise<AgentRecord> {
    await writeLatestEvent(
      this.pool,
      this.logger,
      id,
      input,
      this.notifyEventRecorded
    );

    // Agent could be soft-deleted between the UPDATE and this SELECT in rare
    // races. Guard against null to prevent downstream crashes (e.g. in event
    // listeners).
    const agent = await this.getAgent(id);
    if (!agent) {
      throw new AgentError("Agent not found.", 404);
    }
    this.eventBus.publish(agent);
    // Fire-and-forget: refresher swallows its own errors, throttles bursts,
    // and dedupes concurrent signals. We just nudge it on every status
    // transition so the diff badge tracks scope as work lands.
    void this.diffStatsRefresher?.signal(id);
    return agent;
  }

  async upsertLatestEventIfCurrent(
    id: string,
    expectedUpdatedAt: string,
    input: AgentLatestEventInput
  ): Promise<AgentRecord | null> {
    const updated = await writeLatestEventIfCurrent(
      this.pool,
      this.logger,
      id,
      expectedUpdatedAt,
      input,
      this.notifyEventRecorded
    );
    if (!updated) return null;

    const agent = await this.getAgent(id);
    if (!agent) return null;
    this.eventBus.publish(agent);
    void this.diffStatsRefresher?.signal(id);
    return agent;
  }

  /**
   * Update in place when the pin already exists, append otherwise. Position
   * is deliberately stable: re-pinning to refresh a value must not shuffle the
   * sidebar out from under the user, and grouped pins would tear apart if an
   * update relocated a member.
   *
   * The pin is addressed by `id` when the caller supplies one and by label
   * otherwise — see `applyPinSpec`, which both this and the batch path share
   * so the two cannot drift apart.
   */
  async upsertPin(
    id: string,
    pin: PinSpec
  ): Promise<{ agent: AgentRecord; pin: AgentPin; created: boolean }> {
    // Assigned by the mutation below, which always runs before we read it.
    let stored!: AgentPin;
    let created = true;
    await this.mutatePins(id, (currentPins) => {
      const result = applyPinSpec(currentPins, pin);
      stored = result.stored;
      created = result.created;
      return result.pins;
    });

    return {
      agent: (await this.getAgent(id)) as AgentRecord,
      pin: stored,
      created,
    };
  }

  /**
   * Write many pins in one transaction.
   *
   * The point is atomicity and a single round trip: applying N pins through
   * `upsertPin` costs N transactions, N `getAgent` reads and N sidebar
   * re-renders, and a failure halfway leaves the set half-applied.
   *
   * In `replace` mode the named group is rebuilt to contain exactly `specs`,
   * in order. There is deliberately no whole-list replace: every destructive
   * batch has to name the group it is allowed to clear, so no call can remove
   * a pin the agent forgot to restate.
   */
  async upsertPins(
    id: string,
    specs: PinSpec[],
    options: { mode?: "merge" | "replace"; group?: string } = {}
  ): Promise<{ agent: AgentRecord }> {
    const mode = options.mode ?? "merge";
    if (mode === "replace" && !options.group?.trim()) {
      throw new AgentError(
        "Replace mode requires a group to scope the replacement to.",
        400
      );
    }

    await this.mutatePins(id, (currentPins) =>
      mode === "replace"
        ? replacePinGroup(currentPins, options.group!, specs).pins
        : applyPinSpecs(currentPins, specs).pins
    );

    return { agent: (await this.getAgent(id)) as AgentRecord };
  }

  async deletePinById(id: string, pinId: string): Promise<AgentRecord> {
    await this.mutatePins(id, (currentPins) =>
      removePinsByIds(currentPins, [pinId])
    );

    return (await this.getAgent(id)) as AgentRecord;
  }

  /** Delete several pins by id in one transaction; every id must exist. */
  async deletePinsByIds(id: string, pinIds: string[]): Promise<AgentRecord> {
    await this.mutatePins(id, (currentPins) =>
      removePinsByIds(currentPins, pinIds)
    );

    return (await this.getAgent(id)) as AgentRecord;
  }

  /** Clear an entire group in one transaction. */
  async deletePinsByGroup(id: string, group: string): Promise<AgentRecord> {
    await this.mutatePins(id, (currentPins) =>
      removePinGroup(currentPins, group)
    );

    return (await this.getAgent(id)) as AgentRecord;
  }

  async deletePinByLabel(id: string, label: string): Promise<AgentRecord> {
    await this.mutatePins(id, (currentPins) => {
      const pins = currentPins.filter(
        (pin) => pin.label.toLowerCase() !== label.toLowerCase()
      );
      if (pins.length === currentPins.length) {
        throw new AgentError("Pin not found.", 404);
      }
      return pins;
    });

    return (await this.getAgent(id)) as AgentRecord;
  }

  private async mutatePins(
    id: string,
    mutate: (pins: AgentPin[]) => AgentPin[]
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ pins: AgentPin[] }>(
        "SELECT pins FROM agents WHERE id = $1 FOR UPDATE",
        [id]
      );
      if (result.rows.length === 0)
        throw new AgentError("Agent not found.", 404);
      const currentPins = result.rows[0]!.pins ?? [];
      const pins = mutate(currentPins);
      await client.query(
        "UPDATE agents SET pins = $2::jsonb, updated_at = NOW() WHERE id = $1",
        [id, JSON.stringify(pins)]
      );
      // Same transaction as the write, so the Chat feed's pin history can
      // never disagree with what the sidebar shows.
      await recordPinEvents(client, id, diffPins(currentPins, pins));
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async reconcileAgents(): Promise<void> {
    // Two passes: status reconciliation + orphan-session cleanup. The
    // SSE broadcaster doesn't need the changed-record list at this
    // entry point, so we drop the return value.
    await this.reconciler.reconcileAgentStatuses();
    await this.reconciler.cleanupOrphanedHosts();
  }

  /**
   * Status-only reconciliation pass — the historical contract. Returns
   * the records whose status the reconciler changed. Callers that want
   * the orphan-session cleanup too should call `reconcileAgents()`.
   */
  async reconcileAgentStatuses(): Promise<AgentRecord[]> {
    return this.reconciler.reconcileAgentStatuses();
  }

  /** The agent's working directory: the worktree when it has one. */
  async resolveRuntimeCwd(agent: AgentRecord): Promise<string> {
    return agent.cwd;
  }

  private async validateWorkingDirectory(rawCwd: string): Promise<string> {
    const cwd = rawCwd.startsWith("~/")
      ? path.join(process.env.HOME ?? "/", rawCwd.slice(2))
      : rawCwd === "~"
        ? (process.env.HOME ?? "/")
        : rawCwd;

    if (!path.isAbsolute(cwd)) {
      throw new AgentError("Working directory must be an absolute path.", 400);
    }

    const directory = await stat(cwd).catch(() => null);
    if (!directory || !directory.isDirectory()) {
      throw new AgentError(
        "Working directory does not exist or is not a directory.",
        400
      );
    }

    return cwd;
  }

  private async getRequiredAgent(id: string): Promise<AgentRecord> {
    const agent = await this.getAgent(id);
    if (!agent) {
      throw new AgentError("Agent not found.", 404);
    }

    return agent;
  }

  private async setAgentStatus(
    id: string,
    status: AgentStatus,
    lastError: string | null,
    tmuxSession?: string
  ): Promise<void> {
    const shouldSetTmuxSession = typeof tmuxSession === "string";
    const result = await this.pool.query(
      `
      UPDATE agents
      SET status = $2,
          last_error = $3,
          tmux_session = CASE WHEN $4::boolean THEN $5 ELSE tmux_session END,
          updated_at = NOW()
      WHERE id = $1
      `,
      [id, status, lastError, shouldSetTmuxSession, tmuxSession ?? null]
    );

    if (result.rowCount !== 1) {
      this.logger.warn(
        { id, status },
        "Agent status update skipped because row was missing."
      );
    }
  }

  // --- Media ---

  async listMedia(agentId: string): Promise<
    Array<{
      fileName: string;
      filePath: string;
      description: string | null;
      source: string;
      sizeBytes: number;
      createdAt: string;
    }>
  > {
    return telemetry.listMedia(this.pool, agentId, (id) =>
      this.defaultMediaDir(id)
    );
  }

  private baseAgentSelectSql(): string {
    return `
      SELECT
        id,
        name,
        type,
        role,
        status,
        cwd,
        worktree_path AS "worktreePath",
        worktree_branch AS "worktreeBranch",
        tmux_session AS "tmuxSession",
        simulator_udid AS "simulatorUdid",
        media_dir AS "mediaDir",
        codex_args AS "agentArgs",
        model,
        full_access AS "fullAccess",
        setup_phase AS "setupPhase",
        archive_phase AS "archivePhase",
        archive_cleanup_mode AS "archiveCleanupMode",
        last_error AS "lastError",
        CASE
          WHEN latest_event_type IS NULL OR latest_event_message IS NULL OR latest_event_updated_at IS NULL THEN NULL
          ELSE json_build_object(
            'type',
            latest_event_type,
            'message',
            latest_event_message,
            'updatedAt',
            latest_event_updated_at,
            'metadata',
            COALESCE(latest_event_metadata, '{}'::jsonb)
          )
        END AS "latestEvent",
        COALESCE(pins, '[]'::jsonb) AS "pins",
        git_context AS "gitContext",
        git_context_stale AS "gitContextStale",
        git_context_updated_at AS "gitContextUpdatedAt",
        persona,
        parent_agent_id AS "parentAgentId",
        launched_by_agent_id AS "launchedByAgentId",
        persona_context AS "personaContext",
        review_agent_type AS "reviewAgentType",
        base_branch AS "baseBranch",
        template_id AS "templateId",
        auto_review AS "autoReview",
        (
          SELECT json_build_object(
            'continuationEnabled',
              COALESCE((job_runs.config ->> 'continuationEnabled')::boolean, false),
            'iteration', job_runs.chain_iteration,
            'maxIterations', (job_runs.config ->> 'maxIterations')::integer
          )
          FROM job_runs
          WHERE job_runs.agent_id = agents.id
          LIMIT 1
        ) AS "jobRun",
        cli_session_id AS "cliSessionId",
        (
          SELECT unified_review.id
          FROM reviews unified_review
          WHERE unified_review.reviewer_type = 'agent'
            AND unified_review.reviewer_agent_id = agents.id
          ORDER BY unified_review.created_at DESC, unified_review.id DESC
          LIMIT 1
        ) AS "submittedReviewId",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM agents
      WHERE deleted_at IS NULL
    `;
  }

  private newAgentId(): string {
    return `agt_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  }

  private defaultMediaDir(agentId: string): string {
    return path.join(this.config.mediaRoot, agentId);
  }

  private async setSetupPhase(id: string, phase: SetupPhase): Promise<void> {
    await this.pool.query(
      `UPDATE agents SET setup_phase = $2, updated_at = NOW() WHERE id = $1`,
      [id, phase]
    );
  }

  private async setArchivePhase(
    id: string,
    phase: ArchivePhase
  ): Promise<void> {
    await this.pool.query(
      `UPDATE agents SET archive_phase = $2, updated_at = NOW() WHERE id = $1`,
      [id, phase]
    );
  }

  private async setSystemLatestEvent(
    id: string,
    input: AgentLatestEventInput
  ): Promise<void> {
    try {
      await this.upsertLatestEvent(id, {
        ...input,
        metadata: {
          ...(input.metadata ?? {}),
          source: "system",
        },
      });
    } catch (error) {
      this.logger.warn(
        { err: error, id, eventType: input.type },
        "Failed to upsert system latest event."
      );
    }
  }

  private archiveDeps(): ArchiveDeps {
    return {
      pool: this.pool,
      logger: this.logger,
      runtime: this.runtime,
      diffStatsRefresher: this.diffStatsRefresher,
      getAgent: (id) => this.getAgent(id),
      getRequiredAgent: (id) => this.getRequiredAgent(id),
      setAgentStatus: (id, status, lastError) =>
        this.setAgentStatus(id, status, lastError),
      settleStream: (id) => this.streamStore.settleInterrupted(id, "stopped"),
      setArchivePhase: (id, phase) => this.setArchivePhase(id, phase),
    };
  }
}
