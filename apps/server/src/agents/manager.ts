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
import { resolveFilesDir } from "../shared/files.js";
import {
  buildGitContextForWorktree,
  probeGitContext,
} from "../shared/git/git-context.js";
import { getActivePersonality } from "../db/personalities.js";
import { isTrimmedLaunchGuidanceEnabled } from "../launch-guidance-settings.js";
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
import { type SeededFile, seedInitialFiles } from "./file-seed.js";
import { type Reconciler, createReconciler } from "./reconciler.js";
import { type AgentRuntime, createAgentRuntime } from "./runtime.js";
import {
  buildStartupTurn,
  type ChatLaunchPost,
  shouldSuggestSessionRename,
} from "./launch-guidance.js";
import { prepareWorkspace } from "./workspace.js";
import { createAgentMcpToken, createJobMcpToken } from "../auth.js";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { DriverEvent } from "./acp/driver.js";
import { recordEngineModels } from "./engine-models.js";
import { parsePromptSource, type PromptSource } from "./acp/prompt-source.js";
import { type EngineBins, isAcpEngine } from "./acp/engine-spec.js";
import { buildLaunchEnv } from "./acp/launch-env.js";
import { dispatchMcpUrl } from "./acp/mcp-url.js";
import {
  INTERRUPTED_BY_RESTART,
  STOPPED_ON_REQUEST,
  StreamRecorder,
  type TurnBlocks,
} from "./acp/stream-recorder.js";
import { OPEN_INPUT_SQL } from "../chat/store.js";
import { engineStatuses, missingEngineMessage } from "./engine-availability.js";
import { StreamStore } from "./acp/stream-store.js";
import { buildSystemPrompt } from "./acp/system-prompt.js";
import type {
  AgentGitContext,
  AgentLatestEventInput,
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
  AgentRecord,
  AgentRole,
  AgentTerminalAccess,
  WorktreeStatus,
} from "./types.js";

const CODEX_FULL_ACCESS_ARG = "--dangerously-bypass-approvals-and-sandbox";

/** The first line of a prompt or answer, short enough for the sidebar. */
function statusLine(text: string): string {
  const line =
    text
      .split("\n")
      .find((l) => l.trim().length > 0)
      ?.trim() ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

const ENGINE_LABELS: Record<AgentType, string> = {
  claude: "Claude Code",
  codex: "Codex",
};
const CLAUDE_FULL_ACCESS_ARG = "--dangerously-skip-permissions";

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
   * feed should not repeat); `links` are the raw startup URLs. Internal/generated startup prompts are deliberately
   * omitted unless a caller explicitly supplies their user-authored context.
   */
  launchContext?: {
    prompt?: string;
    links?: string[];
  };
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
  filesDir: string;
  agentArgs: string[];
  model: string | undefined;
  fullAccess: boolean;
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
  files?: Array<{ fileId: number }>;
  links?: string[];
  launchedByAgentId?: string | null;
};

export type LaunchContextRecorder = {
  prepareLaunchContext: (input: LaunchContextInput) => Promise<{
    /**
     * Every startup file and link, described the way the pane lists
     * them. Not capped: the post may show fewer, but the CLI's first turn
     * has to name all of the context the agent was launched with.
     */
    attachmentLines: string[];
    /** Rejects when the post was not written, including an id collision. */
    record: () => Promise<unknown>;
  } | null>;
  /** The system prompt as the first block of the agent's stream. */
  recordSystemPrompt?: (input: {
    agentId: string;
    prompt: string;
  }) => Promise<unknown>;
  /** One phase of the workspace coming up, drawn in the stream as it runs. */
  recordStartupStep?: (input: {
    agentId: string;
    phase: string;
    label: string;
    cwd?: string;
  }) => Promise<unknown>;
  /** The workspace finished coming up, or failed to. */
  recordStartupDone?: (input: {
    agentId: string;
    error?: string;
    cwd?: string;
  }) => Promise<unknown>;
};

/** The two settings-backed switches the launch guidance is built from. */
async function readLaunchGuidanceFlags(
  pool: Pool
): Promise<{ trimmedGuidance: boolean }> {
  const [trimmedGuidance] = await Promise.all([
    isTrimmedLaunchGuidanceEnabled(pool),
  ]);
  return { trimmedGuidance };
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
      settleStream: async (id, reason) =>
        (await this.streamStore.settleInterrupted(id, reason)).length,
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
    // A turn a deliberate stop cut is not the agent blocking; the stop
    // path says what the agent is now.
    if (
      event.type === "turn" &&
      !(
        event.state === "settled" &&
        event.error &&
        this.streamRecorder.isStopping(agentId)
      )
    ) {
      await this.deriveTurnStatus(agentId, event);
    }
    if (event.type === "config") {
      await this.applyEngineConfig(agentId, event.options);
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

  /** The engine told us its options: record the model it really runs. */
  private async applyEngineConfig(
    agentId: string,
    options: SessionConfigOption[]
  ): Promise<void> {
    const agent = await this.getAgent(agentId);
    if (!agent) return;
    const { modelChanged } = await recordEngineModels(
      { pool: this.pool, logger: this.logger },
      { id: agent.id, type: agent.type, model: agent.model ?? null },
      options
    );
    if (modelChanged)
      this.eventBus.publish(await this.getRequiredAgent(agentId));
  }

  /**
   * The agent's status, read off its stream rather than reported by it: a
   * turn opening means working, a turn closing means idle unless a question
   * of the agent's is still unanswered (waiting) or the turn failed
   * (blocked). Written as status events so the sidebar, notifications and
   * the Activity page keep one source; the feed hides the per-turn ones.
   */
  private async deriveTurnStatus(
    agentId: string,
    event: Extract<DriverEvent, { type: "turn" }>
  ): Promise<void> {
    const agent = await this.getAgent(agentId);
    if (!agent || agent.status !== "running") return;
    if (event.state === "started") {
      await this.setSystemLatestEvent(agentId, {
        type: "working",
        message: statusLine(
          await this.promptGist(agentId, event.text, event.source)
        ),
        metadata: { source: "system", phase: "turn" },
      });
    } else if (event.error) {
      await this.setSystemLatestEvent(agentId, {
        type: "blocked",
        message: statusLine(event.error),
        metadata: { source: "system", phase: "turn" },
      });
    } else {
      const question = await this.openQuestion(agentId);
      await this.setSystemLatestEvent(agentId, {
        type: question ? "waiting_user" : "idle",
        message: question ? statusLine(question) : "Ready.",
        metadata: { source: "system", phase: "turn" },
      });
    }
    this.eventBus.publish(await this.getRequiredAgent(agentId));
  }

  /**
   * What a prompt says, without its envelope: a Chat prompt carries only
   * the message id, so its text is read back; an agent or system prompt
   * carries the text itself.
   */
  private async promptGist(
    agentId: string,
    prompt: string,
    given?: PromptSource
  ): Promise<string> {
    const source = given ?? parsePromptSource(prompt);
    if (source.source !== "chat") return source.text;
    const result = await this.pool.query<{ text: string }>(
      `SELECT text FROM blocks WHERE id = $1 AND (to_agent_id = $2 OR stream_id = $2)`,
      [source.chatMessageId, agentId]
    );
    return result.rows[0]?.text ?? "";
  }

  /** The newest open question or form the agent posted for people. */
  private async openQuestion(agentId: string): Promise<string | null> {
    const result = await this.pool.query<{ text: string; data: unknown }>(
      `SELECT text, data FROM blocks b
        WHERE b.author_kind = 'agent' AND b.author_agent_id = $1
          AND b.to_agent_id IS NULL AND b.thread_id IS NULL
          AND b.kind IN ('question', 'form')
          AND (b.state IS NULL OR (b.state->'answer' IS NULL AND b.state->'submission' IS NULL))
        ORDER BY b.created_at DESC, b.id DESC
        LIMIT 1`,
      [agentId]
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.text) return row.text;
    const data = row.data as {
      title?: string;
      options?: Array<{ label: string }>;
    } | null;
    return (
      data?.title ??
      data?.options?.map((o) => o.label).join(" / ") ??
      "Waiting for input"
    );
  }

  /** The agent asked the user something in Chat: it is waiting on them now. */
  async noteQuestionPosted(agentId: string, text: string): Promise<void> {
    const agent = await this.getAgent(agentId);
    if (!agent || agent.status !== "running") return;
    await this.setSystemLatestEvent(agentId, {
      type: "waiting_user",
      message: statusLine(text),
      metadata: { source: "system", phase: "turn" },
    });
    this.eventBus.publish(await this.getRequiredAgent(agentId));
  }

  /** The engine or its host died on its own: the agent cannot stay running. */
  private async markHostExited(
    agentId: string,
    message: string
  ): Promise<void> {
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
      // The host is spawned at the end of `creating`; a prompt that arrives
      // during workspace setup has nowhere to go yet, but the agent is not
      // dead either.
      if (agent.status === "creating") {
        throw new AgentError("Agent is still starting.", 409);
      }
      await this.setAgentStatus(
        id,
        "stopped",
        "The agent host is no longer running."
      );
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
    text: string,
    source?: PromptSource
  ): { accepted: Promise<void>; settled: Promise<void> } {
    return this.runtime.prompt(id, text, source);
  }

  /** A turn is running or prompts are waiting behind one. */
  isPromptHeld(id: string): boolean {
    return this.runtime.isBusy(id);
  }

  /** The agent host's pid when it is alive (resource sampling). */
  hostPid(id: string): Promise<number | null> {
    return this.runtime.hostPid(id);
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
  async restoreRunningAgents(): Promise<{
    attached: string[];
    lost: string[];
  }> {
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

  /** The stream is blocks only: every turn gets a block through these. */
  attachTurnBlocks(turnBlocks: TurnBlocks): void {
    this.streamRecorder.setTurnBlocks(turnBlocks);
  }

  async listAgents(): Promise<AgentRecord[]> {
    const result = await this.pool.query(
      `${this.baseAgentSelectSql()} ORDER BY created_at DESC`
    );
    return (result.rows as AgentRecord[]).map((row) =>
      this.withLiveActivity(row)
    );
  }

  async getAgent(id: string): Promise<AgentRecord | null> {
    const result = await this.pool.query(
      `${this.baseAgentSelectSql()} AND id = $1`,
      [id]
    );
    const row = result.rows[0] as AgentRecord | undefined;
    return row ? this.withLiveActivity(row) : null;
  }

  /**
   * The select reads `activity` from the rows; whether a turn is running
   * right now only the runtime knows, and it outranks what the rows say.
   */
  private withLiveActivity(agent: AgentRecord): AgentRecord {
    const resting =
      agent.activity === "idle" ||
      agent.activity === "waiting" ||
      agent.activity === "blocked";
    if (
      agent.status === "running" &&
      resting &&
      this.runtime.isBusy(agent.id)
    ) {
      return { ...agent, activity: "working" };
    }
    return agent;
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

  /**
   * Create an agent. By default the call returns once the agent is running
   * (jobs, templates and MCP launches want the outcome). With
   * `detachLaunch`, it returns as soon as the row exists in `creating` and
   * the workspace and host come up in the background, reporting progress
   * through the agent's setup phase and status events: what the UI wants,
   * since it shows the agent while it starts.
   */
  async createAgent(
    input: CreateAgentInput,
    options: { detachLaunch?: boolean } = {}
  ): Promise<AgentRecord> {
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

    let initialFiles: SeededFile[] = [];
    if (input.initialFiles && input.initialFiles.length > 0) {
      try {
        initialFiles = await seedInitialFiles(
          this.pool,
          p.id,
          p.filesDir,
          input.initialFiles
        );
      } catch (error) {
        await this.pool
          .query("DELETE FROM agents WHERE id = $1", [p.id])
          .catch(() => {});
        await rm(p.filesDir, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
    }
    // The settings read is on the create path ahead of the launch's own
    // try/catch, so a rejecting query would otherwise leave the row stuck in
    // `creating`. Route it through the same failure handling the launch uses.
    const launchGuidanceFlags = input.jobRunId
      ? { trimmedGuidance: false }
      : await readLaunchGuidanceFlags(this.pool).catch((error: unknown) =>
          this.failCreate(p.id, error)
        );
    // The launch post is the first turn's envelope, so a launch that carries
    // a prompt waits for the post to be durable before the engine starts.
    // It is written once the workspace is ready rather than up front, so the
    // feed reads setup → launch message → first turn. Job runs keep Chat
    // quiet; their prompt goes as the first turn as-is.
    const recorder = this.launchContextRecorder;
    const wantsEnvelope = recorder !== null && !input.jobRunId;
    const launchPostId = randomUUID();
    const launchContextInput = recorder
      ? this.launchContextInput(p, input, initialFiles, launchPostId)
      : null;
    let launchContextWrite: Promise<void> = Promise.resolve();
    const resolveLaunchPost = async (): Promise<ChatLaunchPost | null> => {
      if (!recorder || !launchContextInput) return null;
      if (wantsEnvelope) {
        return this.resolveDurableLaunchPost(
          recorder,
          p.id,
          launchPostId,
          launchContextInput
        );
      }
      launchContextWrite = this.recordLaunchContextDetached(
        recorder,
        p.id,
        launchContextInput
      );
      return null;
    };

    const launch = this.launchAgent({
      id: p.id,
      name: p.name,
      type: p.type,
      originalCwd: p.originalCwd,
      useWorktree: p.useWorktree,
      createNewBranch: p.createNewBranch,
      worktreeBranchName: p.worktreeBranchName,
      normalizedBaseBranch: p.normalizedBaseBranch,
      worktreePathOverride: p.worktreePathOverride,
      initialPrompt: input.initialPrompt,
      initialFiles,
      resolveLaunchPost,
      launchGuidanceFlags,
      jobRunId: input.jobRunId,
    });

    if (options.detachLaunch) {
      // launchAgent already put the row in its failure state; the rejection
      // has nowhere else to go.
      launch.catch((error: unknown) => {
        this.logger.warn({ err: error, agentId: p.id }, "Agent launch failed");
      });
      void launchContextWrite;
      return (await this.getAgent(p.id)) as AgentRecord;
    }
    await launch;
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
    initialFiles: Array<{ fileId: number }>,
    launchPostId: string
  ): LaunchContextInput {
    return {
      id: launchPostId,
      agentId: p.id,
      text: input.launchContext?.prompt,
      files: initialFiles.map((file) => ({ fileId: file.fileId })),
      links: input.launchContext?.links ?? [],
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
    const type: AgentType = input.type ?? "claude";
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
    const filesDir = path.join(this.config.filesRoot, id);
    await mkdir(filesDir, { recursive: true });

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
      filesDir,
      agentArgs,
      model: input.model,
      fullAccess,
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
      INSERT INTO agents (id, name, type, role, status, cwd, files_dir, agent_args, model, full_access, setup_phase, persona, parent_agent_id, launched_by_agent_id, persona_context, review_agent_type, cli_session_id, auto_review, base_branch, template_id, updated_at)
      VALUES ($1, $2, $3, $4, 'creating', $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, NOW())
      `,
      [
        p.id,
        p.name,
        p.type,
        p.role,
        p.originalCwd,
        p.filesDir,
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
    type: AgentType;
    originalCwd: string;
    useWorktree: boolean;
    createNewBranch: boolean;
    worktreeBranchName: string | undefined;
    normalizedBaseBranch: string | undefined;
    worktreePathOverride: string | undefined;
    initialPrompt: string | undefined;
    initialFiles: SeededFile[];
    /** Writes the launch post once the workspace is ready; see createAgent. */
    resolveLaunchPost: () => Promise<ChatLaunchPost | null>;
    launchGuidanceFlags: { trimmedGuidance: boolean };
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
          onPhase: async (phase) => {
            await this.setSetupPhase(id, phase);
            await this.reportStartupPhase(id, phase, opts.type);
          },
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
      const chatLaunchPost = await opts.resolveLaunchPost();
      const { sessionId } = await this.startHost(agent, {
        resumeSessionId: null,
        jobRunId: opts.jobRunId,
        trimmedGuidance: opts.launchGuidanceFlags.trimmedGuidance,
      });
      await this.pool.query(
        `UPDATE agents SET status = 'running', cli_session_id = $2, setup_phase = NULL, updated_at = NOW() WHERE id = $1`,
        [id, sessionId]
      );
      await this.recordStartup(() =>
        this.launchContextRecorder?.recordStartupDone?.({
          agentId: id,
          cwd: workspace.effectiveCwd,
        })
      );
      await this.populateGitContext(id);
      await this.setSystemLatestEvent(id, {
        type: "idle",
        message: `${ENGINE_LABELS[opts.type]} session started.`,
        metadata: { source: "system", phase: "started" },
      });
      this.eventBus.publish(await this.getRequiredAgent(id));
      const firstTurn = buildStartupTurn(
        {
          initialPrompt: opts.initialPrompt,
          initialFiles: opts.initialFiles,
          chatLaunchPost,
        },
        { jobRunId: opts.jobRunId }
      );
      if (firstTurn) this.sendPromptDetached(id, firstTurn, "first turn");
    } catch (error) {
      if (error instanceof GitWorktreeError) {
        const lastError = `Worktree creation failed: ${error.message}`;
        await this.setAgentStatus(id, "stopped", lastError);
        await this.setSetupPhase(id, null);
        await this.setSystemLatestEvent(id, {
          type: "blocked",
          message: lastError,
        });
        throw new AgentError(lastError, error.statusCode);
      }
      await this.failCreate(id, error);
    }
  }

  /**
   * The Chat feed and the sidebar show the agent's latest status event, so
   * each setup phase reports one: with no pane to watch, this is the only
   * sign that anything is happening while the worktree and host come up.
   */
  private async reportStartupPhase(
    id: string,
    phase: SetupPhase,
    type: AgentType
  ): Promise<void> {
    const step =
      phase === "worktree"
        ? { phase, label: "Creating git worktree" }
        : phase === "env"
          ? { phase, label: "Copying local config" }
          : phase === "deps"
            ? { phase, label: "Installing dependencies" }
            : phase === "session"
              ? { phase, label: `Starting ${ENGINE_LABELS[type]}` }
              : null;
    if (!step) return;
    const message = `${step.label}…`;
    await this.setSystemLatestEvent(id, {
      type: "working",
      message,
      metadata: { source: "system", phase: "setup", setupPhase: phase },
    });
    // The same phase in the stream, where there is room to show it as the
    // work it is. A recorder that is absent or fails must never take the
    // launch down with it.
    await this.recordStartup(() =>
      this.launchContextRecorder?.recordStartupStep?.({
        agentId: id,
        ...step,
      })
    );
  }

  /** Stream bookkeeping for a launch: best effort, never fatal. */
  private async recordStartup(
    write: () => Promise<unknown> | undefined
  ): Promise<void> {
    try {
      await write();
    } catch (error) {
      this.logger.warn(
        { err: error },
        "could not record the workspace step in the stream"
      );
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
    const filesDir = resolveFilesDir(
      agent.id,
      agent.filesDir,
      this.config.filesRoot
    );
    await mkdir(filesDir, { recursive: true });
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
    // What the agent was told, at the head of its stream. Best effort in
    // full: a launch must not fail because this record could not be
    // written, whether the write rejects or the recorder cannot do it at
    // all. try/catch, not .catch(), so a synchronous throw is caught too.
    try {
      await this.launchContextRecorder?.recordSystemPrompt?.({
        agentId: agent.id,
        prompt: systemPrompt,
      });
    } catch (error) {
      this.logger.warn(
        { err: error, agentId: agent.id },
        "could not record the agent's system prompt"
      );
    }
    const { env, pathPrefix } = buildLaunchEnv({
      agentId: agent.id,
      role: agent.role,
      filesDir,
      engine: agent.type,
      config: this.config,
    });
    // The adapter ships in this binary, but the engine itself is the
    // person's: say so plainly here rather than letting the spawn fail with
    // ENOENT once the host is already up. The inert runtime spawns nothing,
    // so it needs no engine.
    const engine = this.runtime.tracksProcesses()
      ? (
          await engineStatuses({
            claude: this.config.claudeBin,
            codex: this.config.codexBin ?? undefined,
          })
        ).find((status) => status.id === agent.type)
      : undefined;
    if (engine && !engine.installed) {
      throw new AgentError(missingEngineMessage(engine), 422);
    }
    // The engine this agent runs takes the path we just resolved (a
    // service's PATH rarely has it); the other keeps its configured value.
    const bins: EngineBins = {
      claudeBin:
        agent.type === "claude"
          ? (engine?.path ?? this.config.claudeBin)
          : this.config.claudeBin,
      codexBin:
        agent.type === "codex" ? (engine?.path ?? null) : this.config.codexBin,
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
      model: agent.model ?? null,
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
    // A workspace that never came up says so where it was being watched.
    await this.recordStartup(() =>
      this.launchContextRecorder?.recordStartupDone?.({
        agentId: id,
        error: message,
      })
    );
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
      this.streamRecorder.beginStop(id);
      await this.runtime.stop(id, force);
      await this.streamRecorder.settleStopped(id);
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
    lastError: string | null
  ): Promise<void> {
    const result = await this.pool.query(
      `
      UPDATE agents
      SET status = $2,
          last_error = $3,
          updated_at = NOW()
      WHERE id = $1
      `,
      [id, status, lastError]
    );

    if (result.rowCount !== 1) {
      this.logger.warn(
        { id, status },
        "Agent status update skipped because row was missing."
      );
    }
  }

  // --- Files ---

  async listFiles(agentId: string): Promise<
    Array<{
      fileName: string;
      filePath: string;
      description: string | null;
      source: string;
      sizeBytes: number;
      createdAt: string;
    }>
  > {
    return telemetry.listFiles(this.pool, agentId, (id) =>
      this.defaultFilesDir(id)
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
        simulator_udid AS "simulatorUdid",
        files_dir AS "filesDir",
        agent_args AS "agentArgs",
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
        ${ACTIVITY_SQL} AS activity,
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
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM agents
      WHERE deleted_at IS NULL
    `;
  }

  private newAgentId(): string {
    return `agt_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  }

  private defaultFilesDir(agentId: string): string {
    return path.join(this.config.filesRoot, agentId);
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
      beginStopStream: (id) => this.streamRecorder.beginStop(id),
      settleStream: (id) => this.streamRecorder.settleStopped(id),
      setArchivePhase: (id, phase) => this.setArchivePhase(id, phase),
    };
  }
}

/**
 * An agent's activity as its rows state it, on the unaliased `agents` row.
 * Its status wins while it is starting or not running; then an open question
 * or form for people; then a newest turn that failed. A turn cut by a restart
 * or a deliberate stop (stop, archive) is an interruption, not a failure, as
 * the stream shows it too. A turn
 * running right now is the runtime's to say: see withLiveActivity.
 */
const ACTIVITY_SQL = `CASE
          WHEN status = 'creating' THEN 'starting'
          WHEN status = 'error' THEN 'blocked'
          WHEN status <> 'running' THEN 'stopped'
          WHEN setup_phase IS NOT NULL THEN 'starting'
          WHEN EXISTS (
            SELECT 1 FROM blocks b
             WHERE b.author_kind = 'agent' AND b.author_agent_id = agents.id
               AND b.to_agent_id IS NULL AND ${OPEN_INPUT_SQL}
          ) THEN 'waiting'
          WHEN COALESCE((
            SELECT t.payload->>'error' FROM agent_stream_events t
             WHERE t.agent_id = agents.id AND t.kind = 'turn'
             ORDER BY t.seq DESC LIMIT 1
          ) NOT IN ('${INTERRUPTED_BY_RESTART}', '${STOPPED_ON_REQUEST}'), false) THEN 'blocked'
          ELSE 'idle'
        END`;
