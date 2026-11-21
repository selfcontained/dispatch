import { requestCheckoutCommand } from "./checkout-commands.js";
import { REPO_TOOL_MANIFEST_PATH } from "../shared/mcp/repo-tools.js";
import { isPromptImageMimeType } from "./acp/prompt-source.js";
import { readSessionFile } from "../files/session-file.js";
import { readAgentView } from "./checkout-runner.js";
import {
  agentComparisonBase,
  type ComparisonBaseAgent,
  type ComparisonUse,
} from "./effective-base.js";
import type { CheckoutView } from "@dispatch/runner-protocol";
import { AttentionHistory } from "../notifications/attention-history.js";
import { matchProjectIdentity } from "../projects/matching.js";
import {
  attentionPreview,
  type Effort,
  type FileDiffResponse,
} from "@dispatch/shared";
import { validateAgentEffort } from "../shared/agent-effort.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, unlink } from "node:fs/promises";
import path from "node:path";

import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";

import type { AppConfig } from "../config.js";
import {
  createDiagnosticsRecorder,
  type DiagnosticsRecorder,
} from "../diagnostics.js";
import { GitWorktreeError } from "../shared/git/worktree.js";
import { resolveFilesDir } from "../shared/files.js";
import { getDirectoryIconPath } from "../shared/directory-icon-cache.js";
import {
  buildGitContextForWorktree,
  gitContextFrom,
  probeGitContext,
} from "../shared/git/git-context.js";
import { getActivePersonality } from "../db/personalities.js";
import { errorMessage } from "../shared/lib/error-message.js";
import {
  beginArchive as beginArchiveImpl,
  cleanupAgentWorktree,
  executeArchive as executeArchiveImpl,
  type ArchiveDeps,
} from "./archive.js";
import {
  observeArchiveCheckout,
  releaseRemoteCheckout,
  type ArchiveCheckoutAgent,
} from "./archive-checkout.js";
import { AgentError } from "./errors.js";
import { type AgentEventBus, createAgentEventBus } from "./events.js";
import { runLifecycleHook } from "./lifecycle-hooks.js";
import {
  type SeedFileInput,
  type SeededFile,
  seedInitialFiles,
} from "./file-seed.js";
import {
  RECONNECT_WARNING,
  type Reconciler,
  createReconciler,
} from "./reconciler.js";
import {
  type AgentRuntime,
  type QueuedPromptAction,
  type QueuedPromptControl,
  createAgentRuntime,
} from "./runtime.js";
import {
  buildStartupTurn,
  type ChatLaunchPost,
  shouldSuggestSessionRename,
} from "./launch-guidance.js";
import type { TerminalBackend } from "../terminal/manager.js";
import { remoteTerminal } from "../terminal/remote.js";
import { createLocalRunner } from "./local-runner.js";
import type { LaunchDirectory, WorktreeRequest } from "./workspace.js";
import { createAgentMcpToken, createJobMcpToken } from "../auth.js";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AvailableCommand } from "@agentclientprotocol/sdk";
import type { DriverEvent } from "./acp/driver.js";
import { recordEngineModels, recordEngineEffort } from "./engine-models.js";
import { syncTurnUsage } from "./usage-recorder.js";
import type {
  PromptSource,
  PromptOptions,
  PromptImage,
} from "./acp/prompt-source.js";
import { type EngineBins, isAcpEngine } from "./acp/engine-spec.js";
import { agentWorkspaceDir, isSafeBranchName } from "./workspace-target.js";
import { inspectAgentCheckout, reviewerWorkspace } from "./checkout-runner.js";
import {
  resolveCheckoutIntent,
  toLocalWorktreeRequest,
  toRunnerCheckout,
  type ResolvedCheckout,
} from "./checkout-intent.js";
import { RemoteEventInbox } from "./remote/event-inbox.js";
import {
  MANAGED_WORKSPACE,
  isCheckoutPath,
  isSessionCheckout,
  remotePlacement,
  isSessionFileData,
  isSessionFilePath,
  type RunnerRepository,
  type LaunchProgress,
  type CheckoutQuery,
  type CheckoutReply,
} from "./remote/protocol.js";
import { parseRepository, parseRepositoryTarget } from "./remote/repository.js";
import { RunnerRevoked, type RemoteRunnerService } from "./remote/service.js";
import { buildLaunchEnv } from "./acp/launch-env.js";
import { dispatchMcpUrl } from "./acp/mcp-url.js";
import {
  INTERRUPTED_BY_RESTART,
  STOPPED_ON_REQUEST,
  StreamRecorder,
  type TurnBlocks,
} from "./acp/stream-recorder.js";
import { OPEN_INPUT_SQL } from "../chat/store.js";
import {
  engineStatuses,
  engineVersion,
  missingEngineMessage,
} from "./engine-availability.js";
import { StreamStore } from "./acp/stream-store.js";
import { resolveLaunchPersona } from "../personas/resolve.js";
import {
  PERSONA_CONTEXT_ARG,
  extractPersonaContext,
} from "./acp/persona-context.js";
import { buildSystemPrompt } from "./acp/system-prompt.js";
import type {
  AgentGitContext,
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
import { StreamWriteThrottle } from "./stream-write-throttle.js";
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

const ENGINE_LABELS: Record<AgentType, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};
const CLAUDE_FULL_ACCESS_ARG = "--dangerously-skip-permissions";

type WorktreeLocation = "sibling" | "nested";

/** The question or form an attention event is about. */
export type AttentionTarget = {
  streamId: string;
  threadId: string | null;
  blockId: string;
  kind: "question" | "form";
};

type CreateAgentInput = {
  name?: string;
  type?: AgentType;
  role?: AgentRole;
  cwd: string;
  agentArgs?: string[];
  model?: string;
  effort?: Effort | null;
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
  /** Existing agents use workspace overrides; UI/templates/jobs use the catalog. */
  personaSource?: "catalog" | "workspace";
  parentAgentId?: string;
  /** Launcher of this agent, recorded even when it is not the parent. */
  launchedByAgentId?: string;
  personaContext?: string;
  reviewAgentType?: AgentType | null;
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
  initialFiles?: SeedFileInput[];
  templateId?: string;
  projectId?: string | null;
  repository?: unknown;
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
  effort: Effort | null;
  fullAccess: boolean;
  normalizedBaseBranch: string | undefined;
  checkout: ResolvedCheckout | null;
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
  agentId: string;
  text?: string;
  files?: Array<{ fileId: number }>;
  links?: string[];
  launchedByAgentId?: string | null;
};

export type LaunchContextRecorder = {
  resolvePromptSource?: (
    agentId: string,
    source: PromptSource
  ) => Promise<PromptSource>;
  prepareLaunchContext: (input: LaunchContextInput) => Promise<{
    /** The launch card the briefing is written onto; the first turn names it. */
    id: string;
    /**
     * Every startup file and link, described the way the pane lists
     * them. Not capped: the post may show fewer, but the CLI's first turn
     * has to name all of the context the agent was launched with.
     */
    attachmentLines: string[];
    images?: PromptImage[];
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
    status?: "done" | "failed";
    detail?: string;
  }) => Promise<unknown>;
  /** The workspace finished coming up, or failed to. */
  recordStartupDone?: (input: {
    agentId: string;
    error?: string;
    cwd?: string;
  }) => Promise<unknown>;
};

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

/** Status note on idle agents an update stopped, until they are resumed. */
export const UPDATE_RESUME_MESSAGE =
  "Dispatch stopped this idle agent for an update. Start it to continue if automatic resume did not finish.";

export class AgentManager {
  private readonly lifecycleOperations = new Map<string, Promise<void>>();
  private async serializeLifecycle<T>(
    id: string,
    action: () => Promise<T>
  ): Promise<T> {
    const previous = this.lifecycleOperations.get(id) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.lifecycleOperations.set(id, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.lifecycleOperations.get(id) === tail)
        this.lifecycleOperations.delete(id);
    }
  }

  private readonly pool: Pool;
  private readonly attentionHistory: AttentionHistory;
  private readonly attentionHistoryListeners = new Set<() => void>();
  onAttentionHistoryChanged(listener: () => void): void {
    this.attentionHistoryListeners.add(listener);
  }
  private readonly logger: FastifyBaseLogger;
  private readonly config: AppConfig;
  private readonly remote?: RemoteRunnerService;
  private readonly diagnostics: DiagnosticsRecorder;
  private readonly eventBus: AgentEventBus;
  private readonly runtime: AgentRuntime;
  private readonly localRunner: ReturnType<typeof createLocalRunner>;
  private readonly reconciler: Reconciler;
  private readonly streamStore: StreamStore;
  private readonly streamRecorder: StreamRecorder;
  /** Listeners told after the stream changed for an agent (coalesced). */
  private readonly streamWriteListeners: Array<(agentId: string) => void> = [];
  private readonly streamWrites = new StreamWriteThrottle((agentId) => {
    for (const listener of this.streamWriteListeners) {
      try {
        listener(agentId);
      } catch (err) {
        this.logger.warn({ err, agentId }, "stream write listener failed");
      }
    }
  });
  private readonly reconnectProgress = new Map<
    string,
    NonNullable<AgentRecord["reconnect"]>
  >();
  private nextReconcileAt: string | null = null;
  private diffStatsRefresher: DiffStatsRefresherHandle | null = null;
  private launchContextRecorder: LaunchContextRecorder | null = null;
  private readonly agentCreatedListeners: Array<(agent: AgentRecord) => void> =
    [];
  private readonly attentionListeners: Array<
    (event: {
      agent: AgentRecord;
      type: "waiting_user" | "blocked";
      message: string;
      target?: AttentionTarget;
    }) => void | Promise<void>
  > = [];
  private readonly pendingPermissionIds = new Map<string, Set<string>>();
  private readonly modelsLearnedListeners: Array<
    (agentType: AgentType) => void
  > = [];

  constructor(
    pool: Pool,
    logger: FastifyBaseLogger,
    config: AppConfig,
    /** Tests inject a fake runtime; the server takes the configured one. */
    options: {
      runtime?: AgentRuntime;
      remote?: RemoteRunnerService;
      classifySteering?: import("./steering.js").ClassifySteering;
    } = {}
  ) {
    this.pool = pool;
    this.attentionHistory = new AttentionHistory(pool, logger, () => {
      for (const listener of this.attentionHistoryListeners) listener();
    });
    this.logger = logger;
    this.config = config;
    this.localRunner = createLocalRunner(config.agentStateRoot, logger);
    this.remote = options.remote;
    this.diagnostics = createDiagnosticsRecorder(logger);
    this.eventBus = createAgentEventBus(logger);
    this.streamStore = new StreamStore(pool);
    this.streamRecorder = new StreamRecorder(this.streamStore, logger);
    const remoteInbox = new RemoteEventInbox(pool);
    this.runtime =
      options.runtime ??
      createAgentRuntime(config, logger, {
        classifySteering: options.classifySteering,
        remote: this.remote,
        remoteInbox,
        preparePromptFiles: (id, images) => this.preparePromptFiles(id, images),
        recoverRemoteEvent: (agentId) =>
          remoteInbox.recover(agentId, (event) =>
            this.handleRuntimeEvent(agentId, event, 0, true)
          ),
        placement: async (id) => {
          const row = (
            await pool.query<{ cwd: string }>(
              "SELECT cwd FROM agents WHERE id = $1",
              [id]
            )
          ).rows[0];
          return row ? remotePlacement(row.cwd) : null;
        },
        hostSeq: async (agentId) => {
          const result = await pool.query<{
            host_seq: number;
            host_journal_id: string | null;
          }>("SELECT host_seq, host_journal_id FROM agents WHERE id = $1", [
            agentId,
          ]);
          return {
            seq: result.rows[0]?.host_seq ?? 0,
            journalId: result.rows[0]?.host_journal_id ?? null,
          };
        },
        syncJournal: async (agentId, journalId, reset) => {
          await pool.query(
            `UPDATE agents SET host_journal_id = $2,
              host_seq = CASE WHEN $3 THEN 0 ELSE host_seq END
             WHERE id = $1`,
            [agentId, journalId, reset]
          );
        },
      });
    this.runtime.onEvent((agentId, event, seq, receivedRemotely) =>
      this.handleRuntimeEvent(agentId, event, seq, receivedRemotely)
    );
    this.reconciler = createReconciler({
      pool,
      logger,
      runtime: this.runtime,
      diagnostics: this.diagnostics,
      getAgent: (id) => this.getAgent(id),
      setAgentStatus: (id, status, lastError) =>
        this.setAgentStatus(id, status, lastError),
      notifyBlocked: (id, message) =>
        this.emitAttention(id, "blocked", message),
      setReconnectProgress: (id, phase) => this.setReconnectProgress(id, phase),
      settleStream: async (id, reason) =>
        (await this.streamStore.settleInterrupted(id, reason)).length,
    });
  }

  /** Register a callback told, coalesced, whenever an agent's stream changed. */
  onStreamWrite(listener: (agentId: string) => void): void {
    this.streamWriteListeners.push(listener);
  }

  private notifyStreamWrite(agentId: string, immediate: boolean): void {
    this.streamWrites.write(agentId, immediate);
  }

  /**
   * One event from an agent's host, in seq order. Folded into the stream
   * rows, then the replay watermark moves; seq 0 is an event the runtime
   * made up for a host that vanished and never moves the watermark.
   */
  private async handleRuntimeEvent(
    agentId: string,
    event: DriverEvent,
    seq: number,
    receivedRemotely = false
  ): Promise<void> {
    if (event.type === "permissions") {
      this.attentionHistory.permissions(agentId, event.requests);
      const previous = this.pendingPermissionIds.get(agentId);
      const added = event.requests.filter(
        (request) => !previous?.has(request.id)
      );
      // Update before awaiting: overlapping snapshots must not notify twice.
      if (event.requests.length) {
        this.pendingPermissionIds.set(
          agentId,
          new Set(event.requests.map((request) => request.id))
        );
      } else {
        this.pendingPermissionIds.delete(agentId);
      }
      for (const request of added) {
        await this.emitAttention(
          agentId,
          "waiting_user",
          "Approval needed: " + attentionPreview(request.title)
        );
      }
      const agent = await this.getAgent(agentId);
      if (agent) this.eventBus.publish(agent);
      return;
    }
    if (event.type === "turn" && event.state !== "settled")
      this.attentionHistory.settleBlocked(agentId);
    await this.streamRecorder.handle(event);
    if (receivedRemotely) await this.streamRecorder.flush(agentId);
    if (event.type === "turn" && event.state === "settled" && event.usage) {
      await this.recordUsage(agentId);
    }
    if (event.type === "update" || event.type === "turn") {
      // ACP activity can change the worktree; the refresher throttles Git reads.
      void this.diffStatsRefresher?.signal(agentId);
    }
    if (event.type === "turn" && event.state === "settled") {
      // The turn may have switched branches; the sidebar reads git_context.
      void this.populateGitContext(agentId, { publishIfChanged: true }).catch(
        (err) =>
          this.logger.warn({ err, agentId }, "Git context refresh failed")
      );
    }
    if (seq > 0 && !receivedRemotely) {
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
      await this.publishTurnActivity(agentId, event);
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
      await this.markHostExited(
        agentId,
        event.stderrTail === RunnerRevoked.reason
          ? RunnerRevoked.reason
          : `The agent exited ${how}${tail}`
      );
    }
    this.notifyStreamWrite(
      agentId,
      event.type === "turn" || event.type === "exit"
    );
  }

  /** Fold the turn the recorder just settled into the token totals; never fails the event. */
  private async recordUsage(agentId: string): Promise<void> {
    try {
      await syncTurnUsage(this.pool, agentId);
    } catch (err) {
      this.logger.warn({ err, agentId }, "could not record turn usage");
    }
  }

  /** The engine told us its options: record the model it really runs. */
  private async applyEngineConfig(
    agentId: string,
    options: SessionConfigOption[]
  ): Promise<void> {
    const agent = await this.getAgent(agentId);
    if (!agent) return;
    const { modelChanged, modelsChanged } = await recordEngineModels(
      { pool: this.pool, logger: this.logger },
      { id: agent.id, type: agent.type, model: agent.model ?? null },
      options,
      { learn: !remotePlacement(agent.cwd) }
    );
    const effortChanged = await recordEngineEffort(this.pool, agent, options);
    if (modelChanged || effortChanged)
      this.eventBus.publish(await this.getRequiredAgent(agentId));
    if (modelsChanged) {
      for (const listener of this.modelsLearnedListeners) {
        try {
          listener(agent.type);
        } catch (err) {
          this.logger.warn({ err, agentId }, "models learned listener failed");
        }
      }
    }
  }

  /** A turn change updates live presence; a failed turn also asks for attention. */
  private async publishTurnActivity(
    agentId: string,
    event: Extract<DriverEvent, { type: "turn" }>
  ): Promise<void> {
    const agent = await this.getAgent(agentId);
    if (!agent || agent.status !== "running") return;
    if (event.state === "settled" && event.error) {
      await this.emitAttention(
        agentId,
        "blocked",
        attentionPreview(event.error)
      );
    }
    this.eventBus.publish(await this.getRequiredAgent(agentId));
  }

  /** The agent asked the user something in Chat: it is waiting on them now. */
  async noteQuestionPosted(
    agentId: string,
    text: string,
    target?: AttentionTarget
  ): Promise<void> {
    const agent = await this.getAgent(agentId);
    if (!agent || agent.status !== "running") return;

    await this.emitAttention(
      agentId,
      "waiting_user",
      attentionPreview(text),
      target
    );
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

    await this.emitAttention(agentId, "blocked", message.slice(0, 200));
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

  private cancelSchedules?: (id: string) => Promise<void>;
  attachScheduleCancellation(cancel: (id: string) => Promise<void>): void {
    this.cancelSchedules = cancel;
  }

  async collectSessionFile(
    agent: AgentRecord,
    filePath: string
  ): Promise<Buffer> {
    const placement = remotePlacement(agent.cwd);
    if (!placement) {
      const { rows } = await this.pool.query<{ id: string; files_dir: string }>(
        `SELECT id, files_dir FROM agents
          WHERE id <> $1 AND files_dir IS NOT NULL
            AND files_dir <> ($2 || '/' || id)`,
        [agent.id, this.config.filesRoot]
      );
      return this.localRunner.collectSessionFile(agent.id, filePath, {
        root: this.config.filesRoot,
        ownDir: resolveFilesDir(
          agent.id,
          agent.filesDir,
          this.config.filesRoot
        ),
        otherDirs: rows.map((row) =>
          resolveFilesDir(row.id, row.files_dir, this.config.filesRoot)
        ),
      });
    }
    if (!this.remote || !isSessionFilePath(filePath))
      throw new AgentError("Invalid runner session file path.", 400);
    const { value } = await this.remote.requestSession(placement, {
      agentId: agent.id,
      kind: "sessionFile",
      operation: { kind: "collect", path: filePath },
    });
    if (!isSessionFileData(value))
      throw new Error("Invalid runner file response.");
    return Buffer.from(value, "base64");
  }

  private async deliverSessionFile(
    agent: AgentRecord,
    source: string,
    name: string
  ) {
    const placement = remotePlacement(agent.cwd);
    if (!placement)
      return this.localRunner.deliverSessionFile(agent.id, source);
    if (!this.remote) throw new Error("Runner session is unavailable.");
    const bytes = await readSessionFile(
      await realpath(path.dirname(source)),
      path.basename(source)
    );
    const { value } = await this.remote.requestSession(placement, {
      agentId: agent.id,
      kind: "sessionFile",
      operation: { kind: "deliver", name, data: bytes.toString("base64") },
    });
    if (!isSessionFilePath(value) || !path.posix.isAbsolute(value))
      throw new Error("Invalid runner input file location.");
    return value;
  }

  private async preparePromptFiles(
    id: string,
    images: PromptImage[]
  ): Promise<PromptImage[]> {
    if (!images.some((image) => image.runnerName !== undefined)) return images;
    const agent = await this.getRequiredAgent(id);
    const prepared: PromptImage[] = [];
    const delivered = new Map<string, string>();
    for (const { path: source, mimeType, runnerName } of images) {
      if (runnerName === undefined) {
        prepared.push({ path: source, mimeType });
        continue;
      }
      let destination = delivered.get(source);
      if (destination === undefined) {
        try {
          destination = await this.deliverSessionFile(
            agent,
            source,
            runnerName
          );
        } catch (error) {
          // Native prompts historically retain a reference if an image is gone.
          if (remotePlacement(agent.cwd)) throw error;
          this.logger.warn(
            { err: error, agentId: id },
            "Native prompt file is unavailable"
          );
          continue;
        }
        delivered.set(source, destination);
      }
      if (isPromptImageMimeType(mimeType))
        prepared.push({ path: destination, mimeType });
    }
    return prepared;
  }

  /** Queue one turn; see AgentRuntime.prompt. */
  promptAgent(
    id: string,
    text: string,
    source?: PromptSource,
    opts?: PromptOptions
  ): { accepted: Promise<void>; settled: Promise<void> } {
    return this.runtime.prompt(id, text, source, opts);
  }

  /** A turn is running or prompts are waiting behind one. */
  isPromptHeld(id: string): boolean {
    return this.runtime.isBusy(id);
  }

  hasOpenTurn(id: string): boolean {
    return this.runtime.hasOpenTurn(id);
  }

  /** Read structured inventory from the existing agent session. */
  getMcpInventory(id: string) {
    return this.runtime.getMcpInventory(id);
  }

  getBackgroundWork(id: string) {
    return (
      this.runtime.getBackgroundWork?.(id) ??
      Promise.resolve({ status: "unsupported" as const, items: [] })
    );
  }

  /** The live session's ACP slash commands, including advertised skills. */
  getCommands(id: string): AvailableCommand[] | null {
    return this.runtime.getCommands(id);
  }

  /** The live session's config options (model, effort, mode); null without one. */
  getConfigOptions(id: string): SessionConfigOption[] | null {
    return this.runtime.getConfigOptions(id);
  }

  /**
   * Change one of the live session's config options. The engine's `config`
   * event that follows moves `agents.model`, so a restart resumes on the
   * model chosen here.
   */
  async setConfigOption(
    id: string,
    configId: string,
    value: string
  ): Promise<SessionConfigOption[]> {
    const access = await this.getTerminalAccess(id);
    if (access.mode !== "live") {
      throw new AgentError(access.message, 409);
    }
    const option = this.runtime
      .getConfigOptions(id)
      ?.find((o) => o.id === configId);
    if (!option) {
      throw new AgentError("The engine does not offer that setting.", 400);
    }
    if (option.id === "mode" || option.category === "mode") {
      throw new AgentError(
        "Choose the access mode when creating the agent.",
        400
      );
    }
    try {
      return await this.runtime.setConfigOption(id, configId, value);
    } catch (err) {
      throw new AgentError(
        err instanceof Error ? err.message : String(err),
        409
      );
    }
  }

  getPermissions(id: string) {
    return this.runtime.getPermissions(id);
  }

  async answerPermission(
    id: string,
    requestId: string,
    optionId: string | null
  ): Promise<void> {
    if (!(await this.getAgent(id)))
      throw new AgentError("Agent not found.", 404);
    try {
      await this.runtime.answerPermission(id, requestId, optionId);
    } catch (err) {
      throw new AgentError(
        err instanceof Error ? err.message : String(err),
        409
      );
    }
  }

  /** The agent host's pid when it is alive (resource sampling). */
  hostPid(id: string): Promise<number | null> {
    return this.runtime.hostPid(id);
  }

  /**
   * Update recovery receipt: the exact `updated_at` of each agent row that
   * still says `running`, read after its host was stopped.
   */
  async updateResumeSnapshot(
    ids: string[]
  ): Promise<{ id: string; updatedAt: string }[]> {
    if (ids.length === 0) return [];
    const result = await this.pool.query<{ id: string; updated_at: string }>(
      `SELECT id, updated_at::text AS updated_at FROM agents
        WHERE id = ANY($1) AND status = 'running' AND deleted_at IS NULL
        ORDER BY id`,
      [ids]
    );
    return result.rows.map((row) => ({
      id: row.id,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * Receipt entries whose row is exactly as the fence left it: still
   * `running`, not deleted, `updated_at` unchanged. Anything else (a stop,
   * archive or edit since, or a migration touching the row) is not resumed.
   */
  async eligibleUpdateResumes(
    entries: { id: string; updatedAt: string }[]
  ): Promise<Set<string>> {
    const eligible = new Set<string>();
    for (const entry of entries) {
      try {
        const result = await this.pool.query(
          `SELECT 1 FROM agents
            WHERE id = $1 AND status = 'running' AND deleted_at IS NULL
              AND updated_at = $2::timestamptz`,
          [entry.id, entry.updatedAt]
        );
        if (result.rows.length === 1) eligible.add(entry.id);
      } catch (err) {
        // An unparseable timestamp is an uncertain entry: skip it.
        this.logger.warn({ err, agentId: entry.id }, "Ignoring resume entry");
      }
    }
    return eligible;
  }

  /**
   * Start the idle hosts an update stopped, one at a time. Each must still
   * be in the state `restoreRunningAgents` left it in, so a user who stopped,
   * started or archived it in the meantime wins. No prompt is replayed: the
   * fence only stopped hosts with no turn running and nothing queued.
   */
  async resumeAgentsAfterUpdate(
    entries: { id: string; updatedAt: string }[]
  ): Promise<string[]> {
    const resumed: string[] = [];
    for (const { id, updatedAt } of entries) {
      const started = await this.serializeLifecycle(id, async () => {
        const current = await this.pool.query(
          `UPDATE agents SET status = 'creating', last_error = NULL, updated_at = NOW()
          WHERE id = $1 AND status = 'stopped' AND deleted_at IS NULL
            AND updated_at = $2::timestamptz RETURNING id`,
          [id, updatedAt]
        );
        if (current.rows.length !== 1) return false;
        try {
          await this.startAgentClaimed(id);
          return true;
        } catch (err) {
          // startAgent already recorded the error and raised attention.
          this.logger.warn({ err, agentId: id }, "Resume after update failed");
          return false;
        }
      });
      if (started) resumed.push(id);
    }
    return resumed;
  }

  /** Agents whose host process is alive, attached or not. */
  listHostedAgentIds(): Promise<string[]> {
    return this.runtime.listHosted();
  }

  /**
   * Update recovery: live hosts whose activity the server cannot vouch for.
   * A host it is not attached to (or whose engine is down) could be mid-turn.
   */
  async recoveryHostActivity(): Promise<{
    busy: string[];
    unattached: string[];
  }> {
    const busy: string[] = [];
    const unattached: string[] = [];
    for (const id of await this.runtime.listHosted()) {
      if (this.runtime.getCommands(id) === null) unattached.push(id);
      else if (this.runtime.isBusy(id)) busy.push(id);
    }
    return { busy, unattached };
  }

  /**
   * Update recovery: hosts outlive a service stop and would keep writing
   * their journals during the backup. Stop idle ones through the runtime
   * only (which removes just their socket and pid files), so agent rows keep
   * their running intent. Reports which it stopped and which still run.
   */
  async stopIdleHostsForRecovery(
    timeoutMs: number
  ): Promise<{ stopped: string[]; remaining: string[] }> {
    const idle = (await this.runtime.listHosted()).filter(
      (id) => !this.runtime.isBusy(id)
    );
    await Promise.race([
      Promise.allSettled(idle.map((id) => this.runtime.stop(id, false))),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
    const remaining = await this.runtime.listHosted();
    return {
      stopped: idle.filter((id) => !remaining.includes(id)),
      remaining,
    };
  }

  controlQueuedPrompt(
    agentIds: string[],
    blockId: string,
    action: QueuedPromptAction
  ): QueuedPromptControl {
    return this.runtime.controlQueuedPrompt(agentIds, blockId, action);
  }

  interruptDelivery(agentIds: string[], blockId: string): Promise<boolean> {
    return (
      this.runtime.interruptDelivery?.(agentIds, blockId) ??
      Promise.resolve(false)
    );
  }

  /** Cancel the running turn (Stop). */
  async cancelTurn(id: string): Promise<void> {
    await this.cancelSchedules?.(id).catch((err) =>
      this.logger.warn(
        { err, agentId: id },
        "could not cancel scheduled messages"
      )
    );
    await this.runtime.cancel(id);
  }

  private async sendPromptDetached(
    id: string,
    text: string,
    what: string,
    opts?: PromptOptions,
    source?: PromptSource
  ): Promise<void> {
    const resolved = await this.launchContextRecorder?.resolvePromptSource?.(
      id,
      source ?? { source: "system", text: what }
    );
    const { accepted, settled } = this.runtime.prompt(
      id,
      text,
      resolved ?? source,
      opts
    );
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
   * with nothing behind it. A host that is alive but didn't answer this
   * one attach attempt (busy journal replay, boot contention) is left
   * "running" rather than declared lost: `reconcileAgents()` runs right
   * after this and would otherwise hand a still-live, possibly mid-turn
   * host to `cleanupOrphanedHosts` for force-stopping. The periodic
   * reconciler keeps retrying the reconnect for it.
   */
  async restoreRunningAgents(options?: {
    /** Idle agents an update fenced; marked for `resumeAgentsAfterUpdate`. */
    resumeAfterUpdate?: ReadonlySet<string>;
  }): Promise<{
    attached: string[];
    lost: string[];
    resumes: { id: string; updatedAt: string }[];
  }> {
    const resumes: { id: string; updatedAt: string }[] = [];
    const attached: string[] = [];
    const lost: string[] = [];
    const pending: string[] = [];
    const result = await this.pool.query<{
      id: string;
      cwd: string;
      workspacePath: string | null;
    }>(
      `SELECT id, cwd, workspace_path AS "workspacePath" FROM agents
        WHERE status IN ('running', 'creating') AND deleted_at IS NULL
        ORDER BY created_at`
    );
    for (const row of result.rows) {
      this.streamRecorder.setCwd(
        row.id,
        remotePlacement(row.cwd) ? row.cwd : (row.workspacePath ?? row.cwd)
      );
      const attachedToHost = await this.runtime.attach(row.id);
      if (!remotePlacement(row.cwd) && this.runtime.inspectNativeHost) {
        try {
          const host = await this.runtime.inspectNativeHost(row.id);
          this.logger.info({ host }, "Observed native host during recovery");
        } catch (err) {
          this.logger.warn(
            { err, agentId: row.id },
            "Native host inspection failed"
          );
        }
      }
      if (attachedToHost) {
        attached.push(row.id);
        continue;
      }
      if (await this.runtime.isAlive(row.id)) {
        pending.push(row.id);
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
        options?.resumeAfterUpdate?.has(row.id)
          ? UPDATE_RESUME_MESSAGE
          : "The agent host was not running when Dispatch restarted.",
        (updatedAt) => {
          if (options?.resumeAfterUpdate?.has(row.id))
            resumes.push({ id: row.id, updatedAt });
        }
      );
    }
    if (attached.length || lost.length || pending.length) {
      this.logger.info({ attached, lost, pending }, "Restored running agents");
    }
    return { attached, lost, resumes };
  }

  /** Register for agent record changes from the runtime and lifecycle. */
  onAgentUpdated(listener: AgentEventListener): void {
    this.eventBus.subscribe(listener);
  }

  onAttention(
    listener: (event: {
      agent: AgentRecord;
      type: "waiting_user" | "blocked";
      message: string;
      target?: AttentionTarget;
    }) => void | Promise<void>
  ): void {
    this.attentionListeners.push(listener);
  }

  /** The lifecycle timer's next probe time, shared with reconnecting cards. */
  async setNextReconcileAt(at: string | null): Promise<void> {
    this.nextReconcileAt = at;
    await Promise.all(
      [...this.reconnectProgress]
        .filter(([, progress]) => progress.phase === "waiting")
        .map(([id]) => this.setReconnectProgress(id, "waiting"))
    );
  }

  private async setReconnectProgress(
    id: string,
    phase: "trying" | "waiting" | null
  ): Promise<void> {
    const next = phase
      ? {
          phase,
          nextRetryAt: phase === "waiting" ? this.nextReconcileAt : null,
        }
      : null;
    const current = this.reconnectProgress.get(id);
    if (
      current?.phase === next?.phase &&
      current?.nextRetryAt === next?.nextRetryAt
    ) {
      return;
    }
    if (next) this.reconnectProgress.set(id, next);
    else this.reconnectProgress.delete(id);
    const agent = await this.getAgent(id);
    if (agent) this.eventBus.publish(agent);
  }

  private async emitAttention(
    agentId: string,
    type: "waiting_user" | "blocked",
    message: string,
    target?: AttentionTarget
  ): Promise<void> {
    if (type === "blocked") this.attentionHistory.blocked(agentId, message);
    const agent = await this.getAgent(agentId);
    if (!agent) return;
    for (const listener of this.attentionListeners) {
      try {
        void Promise.resolve(listener({ agent, type, message, target })).catch(
          (err) =>
            this.logger.warn(
              { err, agentId },
              "Agent attention listener failed"
            )
        );
      } catch (err) {
        this.logger.warn({ err, agentId }, "Agent attention listener failed");
      }
    }
  }

  /** Register a callback told when an engine's published model list changed the catalog for its type. */
  onModelsLearned(listener: (agentType: AgentType) => void): void {
    this.modelsLearnedListeners.push(listener);
  }

  /** Register a callback invoked immediately after an agent record is INSERTed. */
  onAgentCreated(listener: (agent: AgentRecord) => void): void {
    this.agentCreatedListeners.push(listener);
  }

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
    this.streamRecorder.setTurnBlocks({
      ...turnBlocks,
      responseSplit: async (input) => {
        await turnBlocks.responseSplit?.(input);
        // A new response is still the same execution turn, but its deep link
        // changed. Publish that pointer without inventing a new turn event.
        const agent = await this.getAgent(input.agentId);
        if (agent) this.eventBus.publish(agent);
      },
    });
  }

  async listAgents(): Promise<AgentRecord[]> {
    const result = await this.pool.query(
      `${this.baseAgentSelectSql()} ORDER BY created_at DESC`
    );
    return (result.rows as AgentRecord[]).map((row) =>
      this.withLiveActivity(row)
    );
  }

  async terminalBackend(id: string): Promise<TerminalBackend | null> {
    const agent = await this.getAgent(id);
    if (!agent) return null;
    const placement = remotePlacement(agent.cwd);
    if (!placement) return this.localRunner.terminalBackend(agent);
    if (!this.remote) throw new Error("The session runner is unavailable.");
    return remoteTerminal(this.remote, placement, agent.id);
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
    const reconnect =
      agent.status === "running" && agent.lastError === RECONNECT_WARNING
        ? (this.reconnectProgress.get(agent.id) ?? {
            phase: "waiting" as const,
            nextRetryAt: this.nextReconcileAt,
          })
        : null;
    const live = this.liveActivity({
      ...agent,
      reconnect,
      inputState: this.runtime.inputState?.(agent.id),
    });
    // The open turn comes from the stream; only ACP's live turn state decides
    // whether it is still current. Derived activity is a separate UI summary.
    if (agent.status === "running" && this.runtime.hasOpenTurn(agent.id))
      return live;
    return live.currentTurn === null ? live : { ...live, currentTurn: null };
  }

  private liveActivity(agent: AgentRecord): AgentRecord {
    if (
      agent.status === "running" &&
      this.runtime.getPermissions(agent.id).requests.length
    )
      return { ...agent, activity: "waiting" };
    const resting =
      agent.activity === "idle" ||
      agent.activity === "waiting" ||
      agent.activity === "blocked";
    if (
      agent.status === "running" &&
      resting &&
      this.runtime.hasOpenTurn(agent.id)
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
   * (if any) stays visible in the UI rather than disappearing. A moved
   * workspace is probed in place of either.
   *
   * With `publishIfChanged`, an unchanged probe writes nothing, and a
   * changed one is published — for refreshes between lifecycle boundaries,
   * where the agent may have switched branches.
   */
  async populateGitContext(
    id: string,
    opts: { publishIfChanged?: boolean } = {}
  ): Promise<void> {
    const agent = await this.getAgent(id);
    if (!agent) return;

    if (remotePlacement(agent.cwd)) return;
    const result = agent.workspacePath
      ? await probeGitContext(agent.workspacePath)
      : agent.worktreePath && agent.worktreeBranch
        ? await buildGitContextForWorktree({
            worktreePath: agent.worktreePath,
            worktreeBranch: agent.worktreeBranch,
          })
        : await probeGitContext(agent.cwd);

    if (
      opts.publishIfChanged &&
      result.status === "ok" &&
      !agent.gitContextStale &&
      sameGitContext(agent.gitContext, result.value)
    ) {
      return;
    }

    // The probe ran against the workspace read above; a set_workspace that
    // landed meanwhile has probed its own, so this result no longer applies.
    const probedWorkspace = agent.workspacePath;

    if (result.status === "error") {
      this.logger.warn(
        { agentId: id },
        "Git context probe failed; marking stale and continuing."
      );
      await this.pool.query(
        `UPDATE agents SET git_context_stale = true, git_context_updated_at = NOW()
         WHERE id = $1 AND workspace_path IS NOT DISTINCT FROM $2`,
        [id, probedWorkspace]
      );
      return;
    }

    const written = await this.pool.query(
      `
      UPDATE agents
      SET git_context = $2::jsonb,
          git_context_stale = false,
          git_context_updated_at = NOW()
      WHERE id = $1 AND workspace_path IS NOT DISTINCT FROM $3
      `,
      [id, result.value ? JSON.stringify(result.value) : null, probedWorkspace]
    );
    if (opts.publishIfChanged && (written.rowCount ?? 0) > 0) {
      const updated = await this.getAgent(id);
      if (updated) this.eventBus.publish(updated);
    }
  }

  async setProject(id: string, projectId: string | null): Promise<AgentRecord> {
    await this.getRequiredAgent(id);
    if (
      projectId &&
      !(
        await this.pool.query("SELECT id FROM projects WHERE id=$1", [
          projectId,
        ])
      ).rowCount
    )
      throw new AgentError("Project not found.", 404);
    await this.pool.query(
      "UPDATE agents SET project_id=$2, updated_at=now() WHERE id=$1",
      [id, projectId]
    );
    const agent = await this.getRequiredAgent(id);
    this.eventBus.publish(agent);
    return agent;
  }

  /**
   * Point the agent's workspace at the directory it now works in, or back at
   * its launch worktree/cwd with `path: null`. A remote runner confirms and
   * journals the selection for checkout reads and future launches. Archive
   * ownership remains tied to the original binding.
   */
  async setWorkspace(
    id: string,
    input: { path: string | null; baseBranch?: string | null }
  ): Promise<AgentRecord> {
    return this.serializeLifecycle(id, async () => {
      const agent = await this.getRequiredAgent(id);
      const placement = remotePlacement(agent.cwd);
      if (placement) {
        const resolved = await this.selectRunnerCheckout(agent, input);
        await this.pool.query(
          `UPDATE agents
           SET workspace_path = $2, workspace_base_branch = $3,
             git_context = $4::jsonb, git_context_stale = false,
             git_context_updated_at = NOW(), updated_at = NOW()
           WHERE id = $1`,
          [
            id,
            resolved.path,
            resolved.baseBranch,
            resolved.gitContext && JSON.stringify(resolved.gitContext),
          ]
        );
      } else {
        const resolved = await this.localRunner.resolveWorkspace(agent, input);
        await this.pool.query(
          `UPDATE agents
           SET workspace_path = $2, workspace_base_branch = $3, updated_at = NOW()
           WHERE id = $1`,
          [id, resolved.path, resolved.baseBranch]
        );
        await this.populateGitContext(id);
      }
      this.diffStatsRefresher?.clear(id);
      void this.diffStatsRefresher?.signal(id);

      const updated = await this.getRequiredAgent(id);
      this.streamRecorder.setCwd(id, agentWorkspaceDir(updated) ?? updated.cwd);
      this.eventBus.publish(updated);
      return updated;
    });
  }

  private async runnerCheckout(
    agent: AgentRecord,
    operation: { kind: "describe" } | { kind: "select"; path: string | null }
  ) {
    const placement = remotePlacement(agent.cwd);
    if (!placement || !this.remote)
      throw new AgentError("The session runner is unavailable.", 409);
    let value: unknown;
    try {
      ({ value } = await this.remote.requestSession(placement, {
        agentId: agent.id,
        kind: "sessionCheckout",
        operation,
      }));
    } catch (error) {
      throw new AgentError(
        errorMessage(error),
        error instanceof RunnerRevoked ? 403 : 409
      );
    }
    let result: unknown;
    try {
      if (typeof value === "string") result = JSON.parse(value);
    } catch {
      // Treat malformed acknowledgements like missing results.
    }
    if (!isSessionCheckout(result))
      throw new AgentError("Invalid runner checkout response.", 502);
    return result;
  }

  private async selectRunnerCheckout(
    agent: AgentRecord,
    input: { path: string | null; baseBranch?: string | null }
  ) {
    const path = input.path?.trim() || null;
    const baseBranch = input.baseBranch?.trim() || null;
    if (path !== null && !isCheckoutPath(path))
      throw new AgentError(
        "Workspace path must be absolute on the bound runner.",
        400
      );
    if (baseBranch !== null && !isSafeBranchName(baseBranch))
      throw new AgentError("Invalid base branch.", 400);
    const selected = await this.runnerCheckout(agent, { kind: "select", path });
    return {
      path: selected.moved || (path && baseBranch) ? selected.path : null,
      baseBranch: path ? baseBranch : null,
      // The runner probes like populateGitContext; older runners omit it.
      gitContext:
        selected.repositoryRoot && selected.checkoutRoot && selected.branch
          ? gitContextFrom({
              repoRoot: selected.repositoryRoot,
              branch: selected.branch,
              worktreePath: selected.checkoutRoot,
              repoIconPath: null,
            })
          : null,
    };
  }

  /**
   * The agent's effective comparison base (see `agentComparisonBase`), sent
   * explicitly to the local and runner executors. Runner sessions read their
   * launch checkout; a borrowed checkout inherits its owner's.
   */
  async comparisonBase(
    agent: ComparisonBaseAgent & { id: string; runnerManaged?: boolean },
    use: ComparisonUse
  ): Promise<string | null> {
    let launch: RunnerRepository["checkout"] | null = null;
    if (
      agent.runnerManaged &&
      agent.cwd &&
      remotePlacement(agent.cwd) &&
      !agent.workspacePath
    ) {
      const { rows } = await this.pool.query<{
        runner_repository: RunnerRepository | null;
      }>(
        "SELECT owner.runner_repository FROM agents a JOIN agents owner ON owner.id = COALESCE(a.runner_worktree_owner, a.id) WHERE a.id = $1",
        [agent.id]
      );
      launch = rows[0]?.runner_repository?.checkout ?? null;
    }
    return agentComparisonBase(agent, use, launch);
  }

  viewCheckout(
    agent: AgentRecord,
    query: Extract<CheckoutView, { kind: "fileDiff" }>
  ): Promise<FileDiffResponse | null>;
  viewCheckout(agent: AgentRecord, query: CheckoutView): Promise<unknown>;
  async viewCheckout(
    agent: AgentRecord,
    query: CheckoutView
  ): Promise<unknown> {
    const base =
      "baseBranch" in query && query.baseBranch === null
        ? await this.comparisonBase(agent, "changes")
        : null;
    return readAgentView(agent, query, this.remote, base);
  }

  async inspectCheckout(
    agent: AgentRecord,
    query: CheckoutQuery
  ): Promise<CheckoutReply> {
    if (query.kind === "changes" && query.baseBranch === null)
      query = {
        ...query,
        baseBranch: await this.comparisonBase(agent, "review"),
      };
    return inspectAgentCheckout(agent, query, this.remote);
  }

  /**
   * Create an agent. By default the call returns once the agent is running
   * (jobs, templates and MCP launches want the outcome). With
   * `detachLaunch`, it returns as soon as the row exists in `creating` and
   * the workspace and host come up in the background, reporting progress
   * through the agent's setup phase and workspace block: what the UI wants,
   * since it shows the agent while it starts.
   */
  async createAgent(
    input: CreateAgentInput,
    options: {
      detachLaunch?: boolean;
      /** Trusted shared-checkout launch, never accepted from an HTTP launch payload. */
      useWorktreeOf?: string;
      /** Trusted MCP launch with its own checkout on the caller's runner. */
      independentCheckoutOf?: string;
      taskPersonaBody?: string;
      /** Commit owner state before the engine can discover tools or run a turn. */
      beforeLaunch?: (agentId: string) => Promise<void>;
    } = {}
  ): Promise<AgentRecord> {
    input = { ...input };
    const { useWorktreeOf, independentCheckoutOf } = options;
    const independentSource = independentCheckoutOf
      ? await this.getAgent(independentCheckoutOf)
      : null;
    if (
      independentCheckoutOf &&
      (!independentSource ||
        !remotePlacement(independentSource.cwd) ||
        input.cwd !== independentSource.cwd ||
        input.launchedByAgentId !== independentSource.id ||
        (input.parentAgentId && input.parentAgentId !== independentSource.id) ||
        (input.fullAccess && !independentSource.fullAccess) ||
        (input.persona && !options.taskPersonaBody) ||
        useWorktreeOf)
    )
      throw new AgentError("Invalid independent runner checkout binding.", 400);
    if (independentSource) input.projectId = independentSource.projectId;
    if (useWorktreeOf !== undefined) {
      const owner = await this.getAgent(useWorktreeOf);
      if (
        !owner ||
        input.launchedByAgentId !== owner.id ||
        !input.parentAgentId ||
        input.repository ||
        input.useWorktree ||
        (input.cwd !== owner.cwd && input.cwd !== reviewerWorkspace(owner)) ||
        (input.projectId !== undefined && input.projectId !== owner.projectId)
      )
        throw new AgentError("Invalid shared checkout binding.", 400);
      if (input.role === "review") {
        if (!input.persona)
          throw new AgentError("Missing reviewer persona.", 400);
      } else if (
        input.parentAgentId !== owner.id ||
        !remotePlacement(owner.cwd) ||
        (input.fullAccess && !owner.fullAccess) ||
        (input.persona && !options.taskPersonaBody)
      ) {
        throw new AgentError("Invalid child checkout binding.", 400);
      }
      const displayParent =
        input.parentAgentId === owner.id
          ? owner
          : await this.getAgent(input.parentAgentId);
      if (!displayParent || displayParent.projectId !== owner.projectId)
        throw new AgentError(
          "Display parent must belong to the requester's project.",
          400
        );
      input.cwd = reviewerWorkspace(owner);
      input.useWorktree = false;
      input.projectId = owner.projectId;
    }
    const placement = remotePlacement(input.cwd);
    const managed = placement
      ? (this.remote?.isManagedWorkspace(placement) ?? false)
      : false;
    const repository = (() => {
      if (input.repository === undefined) return undefined;
      if (!managed)
        throw new AgentError(
          "Repository checkout requires a managed runner session.",
          400
        );
      try {
        return parseRepositoryTarget(input.repository);
      } catch (error) {
        throw new AgentError(errorMessage(error), 400);
      }
    })();
    if (placement) {
      if (
        !this.remote?.available(placement) ||
        this.config.agentRuntime !== "acp"
      ) {
        throw new AgentError(
          "The enrolled runner workspace is unavailable.",
          409
        );
      }
      if (
        (!useWorktreeOf && !independentSource && input.parentAgentId) ||
        (!managed &&
          (input.jobRunId ||
            input.useWorktree ||
            // A project template selects an existing configured workspace.
            // Project membership is validated below and remains host state.
            Boolean(input.projectId) !== Boolean(input.templateId))) ||
        (input.persona &&
          !useWorktreeOf &&
          !options.taskPersonaBody &&
          !input.templateId &&
          !input.jobRunId)
      ) {
        throw new AgentError(
          "Runner launches require a standalone agent and runner-managed storage.",
          400
        );
      }
      if (
        input.initialFiles?.length &&
        !this.remote.supportsSessionFiles(placement)
      )
        throw new AgentError(
          "Update the runner to launch with startup files.",
          409
        );
      if (useWorktreeOf && !this.remote.supportsSharedWorktree(placement))
        throw new AgentError(
          "Update the runner to launch an agent in an existing checkout.",
          409
        );
      // A repository named without a checkout plan always gets a managed
      // worktree, resolved from the launch's worktree intent below.
      input.useWorktree = repository
        ? !repository.checkout
        : input.useWorktree === true;
    }
    let projectRoot: string | undefined;
    if (input.templateId) {
      const template = (
        await this.pool.query("SELECT project_id FROM templates WHERE id=$1", [
          input.templateId,
        ])
      ).rows[0];
      if (!template) throw new AgentError("Template not found.", 404);
      if (!input.parentAgentId) {
        // A projectless template may launch into a project; a project's
        // template only into its own.
        if (
          template.project_id !== null &&
          input.projectId !== undefined &&
          input.projectId !== template.project_id
        )
          throw new AgentError("Template and project must match.", 400);
        input.projectId = template.project_id ?? input.projectId ?? null;
      }
    }
    if (input.parentAgentId) {
      input.projectId =
        (await this.getAgent(input.parentAgentId))?.projectId ?? null;
    }
    if (input.projectId) {
      const project = (
        await this.pool.query("SELECT repo_root FROM projects WHERE id=$1", [
          input.projectId,
        ])
      ).rows[0];
      if (!project) throw new AgentError("Project not found.", 404);
      projectRoot = project.repo_root;
      if (repository && !repository.url) {
        try {
          repository.url = await this.localRunner.inferRepositoryUrl(
            project.repo_root
          );
        } catch (error) {
          throw new AgentError(errorMessage(error), 400);
        }
      }

      // Project membership only supplies a location when none was selected.
      if (!placement && !input.parentAgentId && !input.cwd) {
        input.cwd = project.repo_root;
      }
    }
    const directory = placement
      ? null
      : await this.localRunner.resolveLaunchDirectory(input.cwd);
    // A project selected explicitly can represent a folder without Git.
    if (
      directory?.git.status === "ok" &&
      directory.git.value === null &&
      input.projectId &&
      !input.parentAgentId &&
      input.useWorktree === undefined
    )
      input.useWorktree = false;
    // Resolve only new, unscoped launches. Membership inherited from a parent
    // (including no project) and explicit/template selections remain authoritative.
    if (directory && !input.projectId && !input.parentAgentId) {
      const projects = (
        await this.pool.query(
          'SELECT id, name, repo_root AS "repoRoot" FROM projects'
        )
      ).rows;
      const matches = await matchProjectIdentity(
        directory.canonicalPath,
        projects.length
          ? await this.localRunner.resolveProjectRoot(directory.canonicalPath)
          : directory.canonicalPath,
        projects,
        (candidate) => this.localRunner.canonicalPath(candidate)
      );
      if (matches.length > 1)
        throw new AgentError(
          `Multiple projects match this directory. Choose a project: ${matches.map((p) => `${p.name} (${p.id})`).join(", ")}.`,
          409
        );
      // Do not replace cwd with the primary checkout: it may be a worktree
      // or a deliberately selected subdirectory.
      if (matches.length === 1) input.projectId = matches[0]!.id;
    }
    if (repository && !repository.url)
      throw new AgentError(
        "Enter a repository URL or select a project with a repository origin.",
        400
      );
    const taskPersona = Boolean(input.persona && input.role !== "review");
    const derivedRepositoryUrl =
      placement && input.useWorktree
        ? repository
          ? repository.url
          : independentSource
            ? (
                await this.runnerCheckout(independentSource, {
                  kind: "describe",
                })
              ).origin
            : projectRoot
              ? await this.localRunner
                  .inferRepositoryUrl(projectRoot)
                  .catch(() => null)
              : null
        : undefined;
    if (derivedRepositoryUrl === null)
      throw new AgentError(
        "An independent runner worktree needs a repository with an HTTPS origin.",
        400
      );
    const taskPersonaBody = async () =>
      options.taskPersonaBody ??
      (
        await resolveLaunchPersona(
          placement ? (projectRoot ?? null) : input.cwd,
          input.persona!,
          "task",
          input.personaSource ?? "catalog"
        )
      ).body;
    if (taskPersona && !options.detachLaunch) {
      const body = await taskPersonaBody();
      input = {
        ...input,
        agentArgs: [...(input.agentArgs ?? []), PERSONA_CONTEXT_ARG, body],
      };
    }
    let runnerRepository =
      repository?.url && repository.checkout
        ? { url: repository.url, checkout: repository.checkout }
        : null;
    const p = await this.prepareCreateInputs(
      input,
      directory?.cwd ?? input.cwd
    );
    if (derivedRepositoryUrl && p.checkout) {
      runnerRepository = {
        url: derivedRepositoryUrl,
        checkout: toRunnerCheckout(p.checkout),
      };
      try {
        parseRepository(runnerRepository);
      } catch (error) {
        throw new AgentError(errorMessage(error), 400);
      }
    }
    await mkdir(p.filesDir, { recursive: true });
    // Restart can see the row before persona and workspace preparation run.
    // Persist the native request first so restart never treats it as a direct launch.
    const worktree =
      directory && p.checkout
        ? toLocalWorktreeRequest(p.checkout, p.name, input.worktreeLocation)
        : null;
    if (directory && worktree)
      await this.localRunner.bindWorkspace(p.id, directory, worktree);
    await this.insertAgentRecord(
      p,
      input,
      runnerRepository,
      managed,
      placement ? useWorktreeOf : undefined
    );

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
    // The launch post is the first turn's envelope, so a launch that carries
    // a prompt waits for the post to be durable before the engine starts.
    // It is written once the workspace is ready rather than up front, so the
    // feed reads setup → launch message → first turn. Job runs keep Chat
    // quiet; their prompt goes as the first turn as-is.
    const recorder = this.launchContextRecorder;
    const wantsEnvelope = recorder !== null && !input.jobRunId;
    const launchContextInput = recorder
      ? this.launchContextInput(p, input, initialFiles)
      : null;
    let launchContextWrite: Promise<void> = Promise.resolve();
    const resolveLaunchPost = async (): Promise<ChatLaunchPost | null> => {
      if (!recorder || !launchContextInput) return null;
      if (wantsEnvelope) {
        return this.resolveDurableLaunchPost(
          recorder,
          p.id,
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
      type: p.type,
      originalCwd: p.originalCwd,
      directory,
      worktree,
      initialPrompt: input.initialPrompt,
      initialFiles,
      resolveLaunchPost,
      jobRunId: input.jobRunId,
      beforeLaunch: options.beforeLaunch,
      preparePersona:
        taskPersona && options.detachLaunch
          ? async () => {
              const body = await taskPersonaBody();
              const result = await this.pool.query(
                "UPDATE agents SET agent_args = $2::jsonb, updated_at = NOW() WHERE id = $1 AND status = 'creating' RETURNING id",
                [
                  p.id,
                  JSON.stringify([...p.agentArgs, PERSONA_CONTEXT_ARG, body]),
                ]
              );
              if (!result.rowCount)
                throw new AgentError("Agent launch was cancelled.", 409);
            }
          : undefined,
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
    initialFiles: Array<{ fileId: number }>
  ): LaunchContextInput {
    return {
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
      messageId: prepared.id,
      attachmentLines: prepared.attachmentLines,
      ...(prepared.images?.length ? { images: prepared.images } : {}),
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
    input: CreateAgentInput,
    originalCwd: string
  ): Promise<PreparedCreateInputs> {
    const placement = remotePlacement(originalCwd);
    // Remember the icon of the directory the user chose, before a managed
    // worktree can change the agent's effective cwd.
    if (!placement) await getDirectoryIconPath(this.pool, originalCwd);
    const id = this.newAgentId();
    const type: AgentType = input.type ?? "claude";
    const effort = validateAgentEffort(
      type,
      input.effort,
      input.model,
      Boolean(placement)
    );
    const role: AgentRole = input.role ?? "standard";
    const fullAccess = type === "opencode" || (input.fullAccess ?? false);
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
    let intent: ReturnType<typeof resolveCheckoutIntent>;
    try {
      intent = resolveCheckoutIntent(input, { id, name });
    } catch (err) {
      if (err instanceof GitWorktreeError) {
        throw new AgentError(err.message, err.statusCode);
      }
      throw err;
    }

    // The engine mints the ACP session id at launch; a caller-supplied one
    // is a session to resume.
    const cliSessionId = input.cliSessionId ?? null;
    const initialSetupPhase: SetupPhase = intent.checkout
      ? "worktree"
      : "session";

    return {
      id,
      type,
      role,
      name,
      originalCwd,
      filesDir,
      agentArgs,
      model: input.model,
      effort,
      fullAccess,
      ...intent,
      cliSessionId,
      initialSetupPhase,
    };
  }

  private async insertAgentRecord(
    p: PreparedCreateInputs,
    input: CreateAgentInput,
    repository: RunnerRepository | null,
    runnerManaged: boolean,
    useWorktreeOf?: string
  ): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO agents (id, name, type, role, status, cwd, launch_cwd, files_dir, agent_args, model, full_access, setup_phase, persona, parent_agent_id, launched_by_agent_id, persona_context, review_agent_type, cli_session_id, base_branch, template_id, project_id, effort, runner_repository, runner_managed, runner_worktree_owner, updated_at)
      VALUES ($1, $2, $3, $4, 'creating', $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22::jsonb, $23, $24, NOW())
      `,
      [
        p.id,
        p.name,
        p.type,
        p.role,
        p.originalCwd,
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
        p.normalizedBaseBranch ?? null,
        input.templateId ?? null,
        input.projectId ?? null,
        p.effort,
        repository ? JSON.stringify(repository) : null,
        runnerManaged,
        useWorktreeOf ?? null,
      ]
    );
  }

  /**
   * Create the workspace, start the host, and send the first turn. Every
   * rejection lands in `failCreate` so the row never sticks in `creating`.
   */
  private async launchAgent(opts: {
    id: string;
    type: AgentType;
    originalCwd: string;
    directory: LaunchDirectory | null;
    worktree: WorktreeRequest | null;
    initialPrompt: string | undefined;
    initialFiles: SeededFile[];
    /** Writes the launch post once the workspace is ready; see createAgent. */
    resolveLaunchPost: () => Promise<ChatLaunchPost | null>;
    jobRunId: string | undefined;
    beforeLaunch?: (agentId: string) => Promise<void>;
    /** Catalog fetches must not block the detached create response. */
    preparePersona?: () => Promise<void>;
  }): Promise<void> {
    const { id } = opts;
    try {
      await opts.preparePersona?.();
      const progress = this.workspaceProgress(id, opts.type);
      const workspace = opts.directory
        ? await this.localRunner.prepareWorkspace(
            id,
            opts.directory,
            opts.worktree,
            progress
          )
        : null;
      if (workspace) await this.storePreparedWorkspace(id, workspace);
      const agent = await this.getRequiredAgent(id);
      const chatLaunchPost = await opts.resolveLaunchPost();
      await opts.beforeLaunch?.(id);
      const { sessionId } = await this.startHost(agent, {
        resumeSessionId: null,
        jobRunId: opts.jobRunId,
        recordWorkspaceProgress: true,
      });
      const remote = remotePlacement(agent.cwd);
      let images = chatLaunchPost?.images;
      try {
        if (opts.initialFiles.length || images?.length) {
          const filesDir = resolveFilesDir(
            id,
            agent.filesDir,
            this.config.filesRoot
          );
          const inputs = [...(images ?? [])];
          const sources = new Set(inputs.map((image) => image.path));
          for (const file of opts.initialFiles) {
            const source = path.join(filesDir, file.fileName);
            if (!sources.has(source)) {
              await this.deliverSessionFile(agent, source, file.fileName);
            }
          }
          images = await this.preparePromptFiles(id, inputs);
        }
      } catch (error) {
        await this.runtime
          .stop(id, true)
          .catch((err: unknown) =>
            this.logger.warn(
              { err, agentId: id },
              "Runner host cleanup after file delivery failure"
            )
          );
        throw error;
      }
      await this.pool.query(
        `UPDATE agents SET status = 'running', cli_session_id = $2, setup_phase = NULL, updated_at = NOW() WHERE id = $1`,
        [id, sessionId]
      );
      await this.recordStartup(() =>
        this.launchContextRecorder?.recordStartupDone?.({
          agentId: id,
          cwd: workspace?.effectiveCwd ?? opts.originalCwd,
        })
      );

      this.eventBus.publish(await this.getRequiredAgent(id));
      const firstTurn = buildStartupTurn(
        {
          initialPrompt: opts.initialPrompt,
          initialFiles: remote
            ? opts.initialFiles.map((file) => ({
                ...file,
                runnerPath: `$DISPATCH_FILES_DIR/${file.fileName}`,
              }))
            : opts.initialFiles,
          chatLaunchPost,
        },
        { jobRunId: opts.jobRunId }
      );
      if (firstTurn)
        await this.sendPromptDetached(
          id,
          firstTurn,
          "first turn",
          images?.length ? { images } : undefined,
          chatLaunchPost
            ? { source: "chat", chatMessageId: chatLaunchPost.messageId }
            : undefined
        );
    } catch (error) {
      if (error instanceof GitWorktreeError) {
        const lastError = `Worktree creation failed: ${error.message}`;
        await this.recordStartup(() =>
          this.launchContextRecorder?.recordStartupDone?.({
            agentId: id,
            error: lastError,
          })
        );
        await this.setAgentStatus(id, "stopped", lastError);
        await this.setSetupPhase(id, null);
        await this.emitAttention(id, "blocked", lastError);

        throw new AgentError(lastError, error.statusCode);
      }
      await this.failCreate(id, error);
    }
  }

  private workspaceProgress(
    id: string,
    type: AgentType
  ): Parameters<typeof this.localRunner.resumeWorkspace>[1] {
    return async (step) => {
      if ("status" in step && step.status) {
        await this.recordStartup(() =>
          this.launchContextRecorder?.recordStartupStep?.({
            agentId: id,
            label: "Installing dependencies",
            ...step,
          })
        );
      } else {
        await this.setSetupPhase(id, step.phase);
        await this.reportStartupPhase(id, step.phase, type);
      }
    };
  }

  private async storePreparedWorkspace(
    id: string,
    workspace: Awaited<ReturnType<typeof this.localRunner.prepareWorkspace>>
  ) {
    const git = workspace.git;
    await this.pool.query(
      `UPDATE agents SET cwd = $2, worktree_path = $3, worktree_branch = $4,
        base_branch = COALESCE($5, base_branch), git_context = $6::jsonb,
        git_context_stale = $7, git_context_updated_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [
        id,
        workspace.effectiveCwd,
        workspace.worktreePath,
        workspace.worktreeBranch,
        workspace.baseBranch,
        git.status === "ok" && git.value ? JSON.stringify(git.value) : null,
        git.status === "error",
      ]
    );
  }

  /** Record setup progress in the stream's workspace block. */
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

    // A recorder that is absent or fails must never take the
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
      previousJobFinished?: boolean;
      recordWorkspaceProgress?: boolean;
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
      agent.role === "review" || opts.jobRunId
        ? null
        : await getActivePersonality(this.pool);
    const systemPrompt = buildSystemPrompt({
      agent,
      personalityPrompt: personality?.prompt ?? null,
      suggestSessionRename: shouldSuggestSessionRename(agent.name, agent.id, {
        role: agent.role,
        jobRunId: opts.jobRunId,
      }),
      jobRunId: opts.jobRunId ?? null,
      previousJobFinished: opts.previousJobFinished,
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
      filesDir,
      engine: agent.type,
      config: this.config,
    });
    // The adapter ships in this binary, but the engine itself is the
    // person's: say so plainly here rather than letting the spawn fail with
    // ENOENT once the host is already up. The inert runtime spawns nothing,
    // so it needs no engine.
    const placement = remotePlacement(agent.cwd) ?? undefined;
    const engine =
      !placement && this.runtime.tracksProcesses()
        ? (
            await engineStatuses({
              claude: this.config.claudeBin,
              codex: this.config.codexBin ?? undefined,
              opencode: this.config.opencodeBin,
            })
          ).find((status) => status.id === agent.type)
        : undefined;
    if (engine && !engine.installed) {
      throw new AgentError(missingEngineMessage(engine), 422);
    }
    // The engine this agent runs takes the path we just resolved (a
    // service's PATH rarely has it); the other keeps its configured value.
    const bins: EngineBins = {
      opencodeBin:
        agent.type === "opencode"
          ? (engine?.path ?? this.config.opencodeBin ?? "opencode")
          : this.config.opencodeBin,
      claudeBin:
        agent.type === "claude"
          ? (engine?.path ?? this.config.claudeBin)
          : this.config.claudeBin,
      codexBin:
        agent.type === "codex" ? (engine?.path ?? null) : this.config.codexBin,
    };
    if (engine?.path) {
      this.logger.info(
        {
          agentId: agent.id,
          engine: agent.type,
          cli: engine.path,
          version: await engineVersion(engine.path),
        },
        "launching agent on engine CLI"
      );
    }
    this.streamRecorder.setCwd(agent.id, agentWorkspaceDir(agent) ?? agent.cwd);
    // Rows a previous host left open (a crash mid-turn) settle first, so the
    // feed never shows a turn that can no longer finish.
    await this.streamRecorder.reconcile(agent.id);
    const remoteMcpOrigin = placement
      ? this.remote?.originFor(placement)
      : undefined;
    const mcpUrl = placement
      ? remoteMcpOrigin &&
        (opts.jobRunId
          ? `${remoteMcpOrigin}/api/mcp/jobs/${opts.jobRunId}/${agent.id}`
          : `${remoteMcpOrigin}/api/mcp/${agent.id}`)
      : dispatchMcpUrl(this.config, agent.id, opts.jobRunId);
    if (
      placement?.workspace === MANAGED_WORKSPACE &&
      this.remote?.available(placement) &&
      this.remote.isManagedWorkspace(placement) !== Boolean(agent.runnerManaged)
    )
      throw new AgentError(
        "The runner workspace mode changed since this agent was created.",
        409
      );
    const binding = placement
      ? (
          await this.pool.query<{
            runner_repository: RunnerRepository | null;
            runner_worktree_owner: string | null;
          }>(
            "SELECT runner_repository, runner_worktree_owner FROM agents WHERE id = $1",
            [agent.id]
          )
        ).rows[0]
      : undefined;
    let progressWrites = Promise.resolve();
    const onWorkspaceProgress = placement
      ? (step: LaunchProgress) => {
          if (!opts.recordWorkspaceProgress) return;
          const write = this.workspaceProgress(agent.id, agent.type);
          progressWrites = progressWrites
            .then(async () => {
              if (step.phase === "workspace") {
                if (binding?.runner_repository)
                  await write({ phase: "worktree" });
              } else if (step.phase === "ready") {
                await write({ phase: "session" });
              } else if ("status" in step) {
                await write({
                  phase: "deps",
                  status: step.status,
                  ...(step.status === "failed" && {
                    detail:
                      "The runner could not install dependencies. Launch is continuing.",
                  }),
                });
              } else {
                await write({ phase: "deps" });
              }
            })
            .catch((err) =>
              this.logger.warn(
                { err, agentId: agent.id },
                "Could not record runner preparation"
              )
            );
        }
      : undefined;
    try {
      return await this.runtime.launch({
        agentId: agent.id,
        repository: binding?.runner_repository ?? undefined,
        ...(binding?.runner_worktree_owner && {
          useWorktreeOf: binding.runner_worktree_owner,
        }),
        cwd: agent.cwd,
        placement,
        engine: agent.type,
        fullAccess: agent.type === "opencode" || agent.fullAccess,
        bins,
        model: agent.model ?? null,
        effort: agent.effort ?? null,
        systemPrompt,
        personaContext: extractPersonaContext(agent.agentArgs ?? []),
        mcp: mcpUrl
          ? {
              url: mcpUrl,
              token: opts.jobRunId
                ? createJobMcpToken(
                    this.config.authToken,
                    opts.jobRunId,
                    agent.id
                  )
                : createAgentMcpToken(this.config.authToken, agent.id),
            }
          : undefined,
        env,
        pathPrefix,
        resumeSessionId: opts.resumeSessionId,
        ...(onWorkspaceProgress && { onWorkspaceProgress }),
      });
    } finally {
      await progressWrites;
    }
  }

  /**
   * Put a half-created agent into its terminal failure state and rethrow.
   *
   * Anything on the create path that can reject has to land here: the row is
   * already inserted as `creating`, so an escaping error would strand it in
   * that state with a stale setup phase.
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
    await this.emitAttention(
      id,
      "blocked",
      `Failed to create agent: ${message}`
    );

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
    return this.serializeLifecycle(id, () => this.claimAndStartAgent(id));
  }
  private async claimAndStartAgent(id: string): Promise<AgentRecord> {
    const claimed = await this.pool.query(
      `UPDATE agents SET status = 'creating', last_error = NULL, updated_at = NOW()
       WHERE id = $1 AND status NOT IN ('creating', 'stopping', 'archiving') AND deleted_at IS NULL RETURNING id`,
      [id]
    );
    if (claimed.rows.length === 0) return this.getRequiredAgent(id);
    return this.startAgentClaimed(id);
  }

  private async startAgentClaimed(id: string): Promise<AgentRecord> {
    let agent = await this.getRequiredAgent(id);
    if (await this.runtime.attach(id)) {
      this.streamRecorder.setCwd(id, agent.workspacePath ?? agent.cwd);
      await this.setAgentStatus(id, "running", null);

      return (await this.getAgent(id)) as AgentRecord;
    }

    await this.setAgentStatus(id, "creating", null);
    try {
      if (!remotePlacement(agent.cwd) && !agent.worktreePath) {
        const workspace = await this.localRunner.resumeWorkspace(
          id,
          this.workspaceProgress(id, agent.type)
        );
        if (workspace) {
          await this.storePreparedWorkspace(id, workspace);
          agent = await this.getRequiredAgent(id);
        }
      }
      // A stopped job still needs its run-scoped tools and launch rules when
      // its host is recreated. Reattaching above keeps the existing context.
      const jobRun = await this.pool.query<{ id: string }>(
        "SELECT id FROM job_runs WHERE agent_id = $1 AND status IN ('started', 'running', 'needs_input') ORDER BY started_at DESC LIMIT 1",
        [id]
      );
      const { sessionId } = await this.startHost(agent, {
        resumeSessionId: agent.cliSessionId ?? null,
        jobRunId: jobRun.rows[0]?.id,
        previousJobFinished: Boolean(agent.jobRun) && !jobRun.rows.length,
      });
      await this.pool.query(
        `UPDATE agents SET status = 'running', cli_session_id = $2, last_error = NULL, setup_phase = NULL, updated_at = NOW() WHERE id = $1`,
        [id, sessionId]
      );
      // Re-populate gitContext on every restart so drift from external git
      // activity gets picked up at start time.
      await this.populateGitContext(id);
      this.eventBus.publish(await this.getRequiredAgent(id));
    } catch (error) {
      const message = errorMessage(error);
      await this.setAgentStatus(id, "error", message);
      await this.emitAttention(
        id,
        "blocked",
        `Failed to start agent: ${message}`
      );

      throw new AgentError(`Failed to start agent: ${message}`, 500);
    }

    return (await this.getAgent(id)) as AgentRecord;
  }

  /**
   * Bring the agent's host down and up again so its engine picks up a new
   * sign-in. Not a Stop: the repo's stop hook does not run and the agent's
   * scheduled messages stay, since nothing about the agent's work changed.
   * A host that is not running is just started.
   */
  async restartHost(id: string): Promise<AgentRecord> {
    return this.serializeLifecycle(id, async () => {
      const agent = await this.getRequiredAgent(id);
      if (agent.status === "running") {
        await this.setAgentStatus(id, "stopping", null);
        try {
          this.streamRecorder.beginStop(id);
          await this.runtime.stop(id, false);
          await this.streamRecorder.settleStopped(id);
          await this.setAgentStatus(id, "stopped", null);
          this.notifyStreamWrite(id, true);
        } catch (error) {
          const message = errorMessage(error);
          await this.setAgentStatus(id, "error", message);
          throw new AgentError(`Failed to restart agent: ${message}`, 500);
        }
      }
      return this.claimAndStartAgent(id);
    });
  }

  async stopAgent(
    id: string,
    input: StopAgentInput = {}
  ): Promise<AgentRecord> {
    return this.serializeLifecycle(id, () =>
      this.stopAgentSerialized(id, input)
    );
  }
  private async stopAgentSerialized(
    id: string,
    input: StopAgentInput
  ): Promise<AgentRecord> {
    const agent = await this.getRequiredAgent(id);
    await this.cancelSchedules?.(id).catch((err) =>
      this.logger.warn(
        { err, agentId: id },
        "could not cancel scheduled messages"
      )
    );
    const force = input.force ?? false;

    if (agent.status === "stopped") {
      // A user Stop cancels pending update resume even while already stopped.
      await this.pool.query(
        "UPDATE agents SET last_error = NULL, updated_at = NOW() WHERE id = $1 AND status = 'stopped'",
        [id]
      );
      return this.getRequiredAgent(id);
    }

    await this.setAgentStatus(id, "stopping", null);

    // Run repo-defined stop hook (best-effort, non-blocking)
    await runLifecycleHook("stop", agent, this.logger, {
      local: this.localRunner,
      remote: this.remote,
    }).catch((err) =>
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

      this.notifyStreamWrite(id, true);
    } catch (error) {
      const message = errorMessage(error);
      await this.setAgentStatus(id, "error", message);
      await this.emitAttention(
        id,
        "blocked",
        `Failed to stop agent: ${message}`
      );

      throw new AgentError(`Failed to stop agent: ${message}`, 500);
    }

    return (await this.getAgent(id)) as AgentRecord;
  }

  async beginArchive(
    id: string,
    cleanupWorktree: WorktreeCleanupMode = "auto",
    checkoutState: string | null = null
  ): Promise<AgentRecord> {
    await this.cancelSchedules?.(id).catch((err) =>
      this.logger.warn(
        { err, agentId: id },
        "could not cancel scheduled messages"
      )
    );
    return beginArchiveImpl(
      this.archiveDeps(),
      id,
      cleanupWorktree,
      checkoutState
    );
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

    let observation;
    try {
      observation = await observeArchiveCheckout(
        this.pool,
        agent,
        this.localRunner,
        this.remote
      );
    } catch {
      throw new AgentError(
        "Checkout status is unavailable on the owning runner.",
        503
      );
    }
    const { checkout, ownership, owner, borrowers } = observation;
    if (ownership === "owned" && !checkout)
      throw new AgentError(
        "Checkout status is unavailable on the owning runner.",
        503
      );
    return {
      ownership,
      owner,
      borrowers,
      checkoutState: checkout?.stateId,
      hasWorktree: checkout !== null,
      hasUnmergedCommits: checkout?.unmerged ?? false,
      hasUncommittedChanges: Boolean(checkout?.uncommittedFiles.length),
      worktreePath: checkout?.path ?? null,
      branchName: checkout?.branch ?? null,
      changedFiles: checkout?.changedFiles ?? [],
      uncommittedFiles: checkout?.uncommittedFiles ?? [],
    };
  }

  /** Run the existing recorder before DB startup as well as on reconcile ticks. */
  async maintainServerLogs(): Promise<void> {
    await this.diagnostics.maybeMaintenanceLogs();
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
    const changed = await this.reconciler.reconcileAgentStatuses();
    void this.retryRunnerCleanup().catch((err) =>
      this.logger.warn({ err }, "Could not retry runner cleanup")
    );
    return changed;
  }

  private runnerCleanupRunning = false;

  private async retryRunnerCleanup(): Promise<void> {
    if (this.runnerCleanupRunning) return;
    // Offline cleanup must never delay the status reconciliation loop.
    this.runnerCleanupRunning = true;
    try {
      const { rows } = await this.pool.query<
        ArchiveCheckoutAgent & {
          mode: WorktreeCleanupMode | null;
        }
      >(
        `SELECT id, cwd, worktree_path AS "worktreePath", base_branch AS "baseBranch",
                worktree_branch AS "worktreeBranch", archive_cleanup_mode AS mode
         FROM agents WHERE runner_cleanup_pending AND deleted_at IS NOT NULL ORDER BY id`
      );
      for (const agent of rows) {
        const { id, cwd, mode } = agent;
        try {
          if (remotePlacement(cwd)) {
            if (!this.remote) continue;
            await this.runtime.stop(id, true);
            await this.streamRecorder.settleStopped(id);
            await this.runtime.clearRemoteState?.(id);
            if (
              (await releaseRemoteCheckout(
                this.pool,
                agent,
                mode ?? "auto",
                this.remote
              )) === "inUse"
            )
              continue;
          } else if (
            await cleanupAgentWorktree(
              this.pool,
              this.logger,
              this.localRunner,
              agent,
              mode ?? "auto",
              {}
            )
          ) {
            continue;
          }
          await this.pool.query(
            "UPDATE agents SET runner_cleanup_pending = false, archive_cleanup_mode = NULL, archive_checkout_state = NULL WHERE id = $1",
            [id]
          );
        } catch (err) {
          this.logger.warn(
            { err, agentId: id },
            "Runner cleanup remains pending"
          );
        }
      }
    } finally {
      this.runnerCleanupRunning = false;
    }
  }

  permitsRemoteAgentMcp(
    placement: NonNullable<ReturnType<typeof remotePlacement>>
  ): boolean {
    return this.remote?.permitsAgentMcp(placement) ?? false;
  }

  remoteRepoOperation(agent: AgentRecord): (() => Promise<string>) | undefined {
    const placement = remotePlacement(agent.cwd);
    if (!placement || !this.remote?.repoToolFor(placement)) return undefined;
    return async () =>
      String(
        (
          await this.remote!.requestSession(placement, {
            kind: "repo",
            agentId: agent.id,
          })
        ).value ?? ""
      );
  }

  readRepoManifest(agent: AgentRecord) {
    return requestCheckoutCommand(
      { local: this.localRunner, remote: this.remote },
      agent,
      {
        kind: "read",
        checkout: "effective",
        path: REPO_TOOL_MANIFEST_PATH,
      }
    );
  }

  runRepoCommand(
    agent: AgentRecord,
    state: string,
    argv: string[],
    signal?: AbortSignal
  ) {
    return requestCheckoutCommand(
      { local: this.localRunner, remote: this.remote },
      agent,
      {
        kind: "run",
        checkout: "effective",
        path: REPO_TOOL_MANIFEST_PATH,
        state,
        argv,
      },
      signal
    );
  }

  /** The agent's working directory: the worktree when it has one. */
  async resolveRuntimeCwd(agent: AgentRecord): Promise<string> {
    return agent.cwd;
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
    onUpdated?: (updatedAt: string) => void
  ): Promise<void> {
    if (status !== "error") this.attentionHistory.settleBlocked(id);
    if (status === "stopped" || status === "archiving")
      this.attentionHistory.permissions(id, []);
    const result = await this.pool.query<{ updated_at: string }>(
      `
      UPDATE agents
      SET status = $2,
          last_error = $3,
          updated_at = NOW()
      WHERE id = $1
      RETURNING updated_at::text AS updated_at
      `,
      [id, status, lastError]
    );

    if (result.rowCount !== 1) {
      this.logger.warn(
        { id, status },
        "Agent status update skipped because row was missing."
      );
    } else {
      onUpdated?.(result.rows[0].updated_at);
      this.eventBus.publish(await this.getRequiredAgent(id));
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
        launch_cwd AS "launchCwd",
        worktree_path AS "worktreePath",
        worktree_branch AS "worktreeBranch",
        workspace_path AS "workspacePath",
        workspace_base_branch AS "workspaceBaseBranch",
        simulator_udid AS "simulatorUdid",
        files_dir AS "filesDir",
        agent_args AS "agentArgs",
        model,
        effort,
        (full_access OR type = 'opencode') AS "fullAccess",
        setup_phase AS "setupPhase",
        archive_phase AS "archivePhase",
        archive_cleanup_mode AS "archiveCleanupMode",
        runner_managed AS "runnerManaged",
        last_error AS "lastError",
        ${ACTIVITY_SQL} AS activity,
        ${CURRENT_TURN_SQL} AS "currentTurn",
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
        project_id AS "projectId",
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
    this.eventBus.publish(await this.getRequiredAgent(id));
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

  private archiveDeps(): ArchiveDeps {
    return {
      pool: this.pool,
      logger: this.logger,
      runtime: this.runtime,
      localRunner: this.localRunner,
      remote: this.remote,
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
/**
 * The newest turn's block and the thread it sits in, while that turn is
 * still open. ACP's live turn state checks whether to expose it: see
 * withLiveActivity.
 */
const CURRENT_TURN_SQL = `(
          SELECT json_build_object('blockId', b.id, 'threadId', b.thread_id, 'streamId', b.stream_id)
            FROM (
              SELECT t.payload FROM agent_stream_events t
               WHERE t.agent_id = agents.id AND t.kind = 'turn'
               ORDER BY t.seq DESC LIMIT 1
            ) newest
            JOIN blocks b ON b.id = (newest.payload->>'blockId')::uuid
           WHERE newest.payload->>'state' = 'started'
        )`;

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

function sameGitContext(
  a: AgentGitContext | null,
  b: AgentGitContext | null
): boolean {
  if (!a || !b) return a === b;
  return (
    a.repoRoot === b.repoRoot &&
    a.branch === b.branch &&
    a.worktreePath === b.worktreePath &&
    a.worktreeName === b.worktreeName &&
    a.isWorktree === b.isWorktree &&
    (a.repoIconPath ?? null) === (b.repoIconPath ?? null)
  );
}
