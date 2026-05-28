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
import {
  buildGitContextForWorktree,
  probeGitContext,
} from "../shared/git/git-context.js";
import { getActivePersonality } from "../db/personalities.js";
import { harvestTokenUsage } from "./token-harvester.js";
import { errorMessage } from "../shared/lib/error-message.js";
import {
  beginArchive as beginArchiveImpl,
  executeArchive as executeArchiveImpl,
  type ArchiveDeps,
} from "./archive.js";
import { AgentError } from "./errors.js";
import {
  type AgentEventBus,
  createAgentEventBus,
  writeLatestEvent,
} from "./events.js";
import { runLifecycleHook } from "./lifecycle-hooks.js";
import { seedInitialMedia } from "./media-seed.js";
import { type Reconciler, createReconciler } from "./reconciler.js";
import { type AgentRuntime, createAgentRuntime } from "./runtime.js";
import {
  buildAgentCommand,
  buildLaunchGuidance,
  buildStartupPrompt,
} from "./tmux/command-builder.js";
import {
  agentIdFromSessionName,
  shouldSuggestSessionRename,
  toSessionName,
} from "./tmux/session-name.js";
import { generateSetupScript } from "./tmux/setup-script.js";
import { setupAgentWorkspace } from "./workspace-prep.js";
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
import type {
  ActivitySummaryResult,
  AgentHistoryEntry,
  AgentHistoryResult,
  FeedbackSummaryResult,
} from "./telemetry.js";
import * as personaReviews from "./persona-reviews.js";
import type {
  PersonaReviewRecord,
  PersonaReviewResolutionItem,
  PersonaReviewResolutionRecord,
} from "./persona-reviews.js";
import * as feedbackQueries from "./feedback.js";
import type { FeedbackInput, FeedbackRecord } from "./feedback.js";

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
export type {
  ActivitySummaryResult,
  AgentHistoryEntry,
  AgentHistoryResult,
  FeedbackSummaryResult,
} from "./telemetry.js";
export type {
  PersonaReviewRecord,
  PersonaReviewResolutionItem,
  PersonaReviewResolutionRecord,
} from "./persona-reviews.js";
export { resolveProgressPingStatus } from "./persona-reviews.js";
export type { FeedbackInput, FeedbackRecord } from "./feedback.js";

const CODEX_FULL_ACCESS_ARG = "--dangerously-bypass-approvals-and-sandbox";
const CLAUDE_FULL_ACCESS_ARG = "--dangerously-skip-permissions";

/**
 * Maximum number of pins per agent. Enforced by `upsertPin` when adding
 * one at a time and by `normalizeInitialPins` when seeding via
 * `createAgent({ initialPins })`. Pins also flow into the startup
 * prompt via `buildStartupPrompt`, so the cap also bounds prompt size.
 */
const MAX_PINS = 50;

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
    byLabel.set(pin.label.toLowerCase(), pin);
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
  personaContext?: string;
  reviewAgentType?: AgentType | null;
  autoReview?: boolean;
  cliSessionId?: string;
  jobRunId?: string;
  initialPrompt?: string;
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

/**
 * Subset of `DiffStatsRefresher` the manager calls into. Defined as a
 * narrow interface so the manager doesn't import the refresher class
 * directly — keeps the refresher's wiring at the server-composition level.
 */
export type DiffStatsRefresherHandle = {
  signal: (agentId: string) => Promise<void>;
  clear: (agentId: string) => void;
};

export class AgentManager {
  private readonly pool: Pool;
  private readonly logger: FastifyBaseLogger;
  private readonly config: AppConfig;
  private readonly diagnostics: DiagnosticsRecorder;
  private readonly eventBus: AgentEventBus;
  private readonly runtime: AgentRuntime;
  private readonly reconciler: Reconciler;
  private diffStatsRefresher: DiffStatsRefresherHandle | null = null;
  private readonly agentCreatedListeners: Array<(agent: AgentRecord) => void> =
    [];

  constructor(pool: Pool, logger: FastifyBaseLogger, config: AppConfig) {
    this.pool = pool;
    this.logger = logger;
    this.config = config;
    this.diagnostics = createDiagnosticsRecorder(logger);
    this.eventBus = createAgentEventBus(logger);
    this.runtime = createAgentRuntime(config, logger);
    this.reconciler = createReconciler({
      pool,
      logger,
      runtime: this.runtime,
      diagnostics: this.diagnostics,
      sessionPrefix: config.sessionPrefix,
      getAgent: (id) => this.getAgent(id),
      setAgentStatus: (id, status, lastError, tmuxSession) =>
        this.setAgentStatus(id, status, lastError, tmuxSession),
      setSystemLatestEvent: (id, input) => this.setSystemLatestEvent(id, input),
    });
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
   * Inject the diff-stats refresher singleton. Wired post-construction so
   * the manager and refresher can each take a reference to the other
   * without a circular constructor dance.
   */
  attachDiffStatsRefresher(refresher: DiffStatsRefresherHandle): void {
    this.diffStatsRefresher = refresher;
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

  /** Harvest token usage for an agent, scoped to its CLI session if known. */
  async harvestAgentTokens(agent: AgentRecord): Promise<void> {
    await harvestTokenUsage(
      this.pool,
      {
        id: agent.id,
        type: agent.type,
        cwd: agent.cwd,
        worktreePath: agent.worktreePath,
        cliSessionId: agent.cliSessionId ?? undefined,
      },
      this.logger
    );
  }

  async createAgent(input: CreateAgentInput): Promise<AgentRecord> {
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
    const tmuxSession = toSessionName(this.config.sessionPrefix, id, name);
    const mediaDir = path.join(this.config.mediaRoot, id);
    await mkdir(mediaDir, { recursive: true });
    // Apply the same cap + de-dup that `upsertPin` enforces; otherwise
    // the create-agent endpoint is a quota bypass and a prompt-bloat
    // vector (pins flow into `buildStartupPrompt`).
    const initialPins = normalizeInitialPins(input.initialPins ?? []);

    const useWorktree = input.useWorktree !== false;
    const createNewBranch = input.createNewBranch ?? true;

    // Normalize ref names up front. assertSafeRefName trims, rejects empty
    // values, and forbids any character that isn't alphanumeric / `_./-`/`/` —
    // which (a) keeps malicious input out of the bash setup script (CRU-139
    // injection vector) and (b) gives us a single canonical form to persist
    // and compare against during archive cleanup. Skip when the field wasn't
    // provided so the existing fallback paths still apply.
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

    // Compute worktree params for the setup script
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
        // When checking out an existing branch without creating a new one,
        // the worktree branch is the starting branch itself.
        worktreeBranchName = normalizedBaseBranch || "main";
      }
      const worktreeLocation = input.worktreeLocation ?? "sibling";
      if (worktreeLocation === "nested") {
        // For nested layout, derive the same hashed slug so two agents on
        // slug-equivalent existing branches don't pick the same path.
        worktreePathOverride = path.join(
          originalCwd,
          ".dispatch",
          "worktrees",
          worktreePathSlug(worktreeBranchName, { createNewBranch })
        );
      }
    }

    // Auto-assign a CLI session ID for Claude agents so we can track which
    // session file belongs to this agent and resume it on restart.
    const cliSessionId =
      input.cliSessionId ?? (type === "claude" ? randomUUID() : null);

    // Insert the agent record immediately so the API can return fast.
    // The setup script running in tmux will handle worktree/deps/etc.
    const initialSetupPhase: SetupPhase = useWorktree ? "worktree" : "session";
    await this.pool.query(
      `
      INSERT INTO agents (id, name, type, role, status, cwd, tmux_session, media_dir, codex_args, full_access, setup_phase, persona, parent_agent_id, persona_context, review_agent_type, cli_session_id, auto_review, base_branch, template_id, pins, updated_at)
      VALUES ($1, $2, $3, $4, 'creating', $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb, NOW())
      `,
      [
        id,
        name,
        type,
        role,
        originalCwd,
        tmuxSession,
        mediaDir,
        JSON.stringify(agentArgs),
        fullAccess,
        initialSetupPhase,
        input.persona ?? null,
        input.parentAgentId ?? null,
        input.personaContext ?? null,
        input.reviewAgentType ?? null,
        cliSessionId,
        input.autoReview ?? false,
        normalizedBaseBranch ?? null,
        input.templateId ?? null,
        JSON.stringify(initialPins),
      ]
    );

    // Notify listeners immediately so the UI can show the agent in
    // "creating" status before potentially slow worktree setup.
    const createdAgent = await this.getAgent(id);
    if (createdAgent) {
      for (const listener of this.agentCreatedListeners) {
        try {
          listener(createdAgent);
        } catch {
          /* listener errors must not break creation */
        }
      }
    }

    let initialMedia: Array<{
      fileName: string;
      displayName: string;
      source: string;
      description: string | null;
    }> = [];
    if (input.initialFiles && input.initialFiles.length > 0) {
      try {
        initialMedia = await seedInitialMedia(
          this.pool,
          id,
          mediaDir,
          input.initialFiles
        );
      } catch (error) {
        await this.pool
          .query("DELETE FROM agents WHERE id = $1", [id])
          .catch(() => {});
        await rm(mediaDir, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
    }
    const startupPrompt = buildStartupPrompt(
      input.initialPrompt,
      initialPins,
      initialMedia
    );

    if (this.config.agentRuntime === "inert") {
      // Inert mode: no tmux, no setup script — do worktree synchronously and go straight to running
      let effectiveCwd = originalCwd;
      let worktreePath: string | null = null;
      let worktreeBranch: string | null = null;

      if (useWorktree && worktreeBranchName) {
        try {
          const result = await createGitWorktree({
            cwd: originalCwd,
            name,
            branchName: createNewBranch ? worktreeBranchName : undefined,
            baseBranch: normalizedBaseBranch,
            worktreePath: worktreePathOverride,
            createNewBranch,
          });
          worktreePath = result.worktreePath;
          worktreeBranch = result.branchName;
          effectiveCwd = result.worktreePath;
          this.logger.info(
            { agentId: id, worktreePath, worktreeBranch },
            "Created worktree for inert agent."
          );
          await setupAgentWorkspace(originalCwd, worktreePath, this.logger);
        } catch (error) {
          // The user explicitly asked for an isolated worktree. Don't silently
          // fall back to running in their primary checkout — surface the
          // failure and mark the agent as failed so it shows up in the UI
          // with a clear last_error.
          const message =
            error instanceof Error ? error.message : String(error);
          const lastError = `Worktree creation failed: ${message}`;
          this.logger.warn(
            { err: error, agentId: id },
            "Worktree creation failed for inert agent."
          );
          await this.setAgentStatus(id, "stopped", lastError);
          await this.setSystemLatestEvent(id, {
            type: "blocked",
            message: lastError,
          });
          if (error instanceof GitWorktreeError) {
            throw new AgentError(lastError, error.statusCode);
          }
          throw new AgentError(lastError, 500);
        }
      }

      await this.pool.query(
        `UPDATE agents SET status = 'running', cwd = $2, worktree_path = $3, worktree_branch = $4, setup_phase = NULL, updated_at = NOW() WHERE id = $1`,
        [id, effectiveCwd, worktreePath, worktreeBranch]
      );
      // Populate gitContext synchronously so the create response and the
      // resulting agent.upsert SSE both carry it — no UI flicker waiting
      // for a background refresh to arrive.
      await this.populateGitContext(id);
      await this.setSystemLatestEvent(
        id,
        type === "terminal"
          ? { type: "idle", message: "Terminal session started." }
          : { type: "idle", message: "Session started." }
      );
    } else {
      try {
        await this.runtime.ensureNoExistingSession(tmuxSession);

        // Personality applies only to regular agent launches. Skip for any
        // specialized role: review personas, job runs, and assisted-update
        // agents — those flows already drive their own prompts and an
        // unrelated voice tweak risks destabilizing them.
        const personality =
          input.persona || input.jobRunId || role === "assisted_update"
            ? null
            : await getActivePersonality(this.pool);

        // Build the agent command that the setup script will exec into
        const agentCommand = buildAgentCommand(
          this.config,
          type,
          role,
          agentArgs,
          mediaDir,
          tmuxSession,
          fullAccess,
          cliSessionId ?? undefined,
          false,
          input.jobRunId,
          shouldSuggestSessionRename(name, id, {
            persona: input.persona,
            jobRunId: input.jobRunId,
            templateId: input.templateId,
          }),
          !input.persona && !input.jobRunId && (input.autoReview ?? false),
          startupPrompt,
          personality?.prompt ?? null
        );
        // Generate a setup script that handles worktree creation, env copy,
        // dep install, and then exec's into the agent CLI — all visible in the terminal.
        // Stderr/exit-capture wrapping is applied by the runtime, not the script.
        const setupScript = generateSetupScript(this.config, {
          agentId: id,
          agentType: type,
          originalCwd,
          useWorktree,
          createNewBranch,
          worktreeBranchName,
          baseBranch: normalizedBaseBranch,
          worktreePathOverride,
          agentName: name,
          agentCommand,
          jobRunId: input.jobRunId,
        });

        await this.runtime.launch({
          sessionName: tmuxSession,
          cwd: originalCwd,
          agentId: id,
          payload: { kind: "setup-script", scriptContent: setupScript },
        });
      } catch (error) {
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
    }

    return (await this.getAgent(id)) as AgentRecord;
  }

  /**
   * Called by the setup script (via API) to report phase transitions and completion.
   * Updates worktree info and transitions the agent to 'running' when setup is done.
   */
  async completeSetup(
    id: string,
    result: {
      effectiveCwd: string;
      worktreePath: string | null;
      worktreeBranch: string | null;
    }
  ): Promise<AgentRecord> {
    const agent = await this.getRequiredAgent(id);
    if (agent.status !== "creating") {
      throw new AgentError("Agent is not in creating state.", 409);
    }

    await this.pool.query(
      `
      UPDATE agents
      SET status = 'running',
          cwd = $2,
          worktree_path = $3,
          worktree_branch = $4,
          setup_phase = NULL,
          updated_at = NOW()
      WHERE id = $1
      `,
      [id, result.effectiveCwd, result.worktreePath, result.worktreeBranch]
    );

    // Populate gitContext now that worktree info is final, so the SSE
    // upsert that follows setSystemLatestEvent (and the route's own
    // upsert) carries the populated context.
    await this.populateGitContext(id);

    await this.setSystemLatestEvent(
      id,
      agent.type === "terminal"
        ? { type: "idle", message: "Terminal session started." }
        : { type: "idle", message: "Session started." }
    );

    // Clean up setup script
    const setupScriptPath = `/tmp/dispatch_setup_${id}.sh`;
    await unlink(setupScriptPath).catch(() => {});

    return (await this.getAgent(id)) as AgentRecord;
  }

  async updateSetupPhase(id: string, phase: SetupPhase): Promise<void> {
    await this.setSetupPhase(id, phase);
  }

  /**
   * Called by the tmux setup script when an unrecoverable failure happens
   * during setup (e.g. `git worktree add` failed). Marks the agent as
   * stopped with the supplied message in `last_error` so the UI surfaces a
   * clear reason instead of the agent silently disappearing.
   */
  async markSetupFailed(id: string, message: string): Promise<AgentRecord> {
    const trimmed = message.trim().slice(0, 1000) || "Setup failed.";
    await this.setAgentStatus(id, "stopped", trimmed);
    await this.setSystemLatestEvent(id, {
      type: "blocked",
      message: trimmed,
    });
    return (await this.getAgent(id)) as AgentRecord;
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
    const tmuxSession =
      agent.tmuxSession ??
      toSessionName(this.config.sessionPrefix, agent.id, agent.name);
    const hasSession = await this.runtime.hasSession(tmuxSession);

    if (hasSession) {
      await this.setAgentStatus(id, "running", null, tmuxSession);
      await this.setSystemLatestEvent(id, {
        type: "idle",
        message: "Session attached to existing tmux session.",
      });
      return (await this.getAgent(id)) as AgentRecord;
    }

    await this.setAgentStatus(id, "creating", null);

    // If the agent has a stored CLI session ID, resume that session.
    // If not (legacy agent), assign one now so future restarts can resume.
    // Use a conditional UPDATE to avoid races from concurrent start requests.
    let cliSessionId = agent.cliSessionId;
    const shouldResume = !!cliSessionId;
    if (!cliSessionId && agent.type === "claude") {
      cliSessionId = randomUUID();
      const { rowCount } = await this.pool.query(
        `UPDATE agents SET cli_session_id = $2 WHERE id = $1 AND cli_session_id IS NULL`,
        [id, cliSessionId]
      );
      if (rowCount === 0) {
        // Another request already assigned a session ID — use that one
        const fresh = await this.getRequiredAgent(id);
        cliSessionId = fresh.cliSessionId;
      }
    }

    try {
      const mediaDir = agent.mediaDir ?? this.defaultMediaDir(id);
      // mediaDir must exist before launch — both runtimes assume the
      // directory is present. (The original inert path created it
      // explicitly; the tmux setup-script path created it via the
      // bash script. We do it once here so both runtimes are happy.)
      await mkdir(mediaDir, { recursive: true });

      const personality =
        agent.persona || agent.role === "assisted_update"
          ? null
          : await getActivePersonality(this.pool);

      const agentCommand = buildAgentCommand(
        this.config,
        agent.type,
        agent.role,
        agent.agentArgs ?? [],
        mediaDir,
        tmuxSession,
        agent.fullAccess ?? false,
        cliSessionId ?? undefined,
        shouldResume,
        undefined,
        shouldSuggestSessionRename(agent.name, id, {
          persona: agent.persona,
          templateId: agent.templateId,
        }),
        !agent.persona && (agent.autoReview ?? false),
        undefined,
        personality?.prompt ?? null
      );

      await this.runtime.launch({
        sessionName: tmuxSession,
        cwd: agent.cwd,
        agentId: id,
        payload: { kind: "agent-command", command: agentCommand },
      });

      await this.setAgentStatus(id, "running", null, tmuxSession);
      // Re-populate gitContext on every restart so existing agents that
      // predate inline-populate still get a fresh context (and any drift
      // from external git activity gets picked up at start time).
      await this.populateGitContext(id);
      await this.setSystemLatestEvent(
        id,
        agent.type === "terminal"
          ? {
              type: "idle",
              // Terminal agents don't track a CLI session id, so `shouldResume`
              // is always false here — but reaching startAgent means the agent
              // was previously stopped, which is definitionally a resume.
              message: "Terminal session resumed.",
            }
          : {
              type: "idle",
              message: shouldResume ? "Session resumed." : "Session started.",
            }
      );
    } catch (error) {
      const message = errorMessage(error);
      await this.setAgentStatus(id, "error", message, tmuxSession);
      await this.setSystemLatestEvent(id, {
        type: "blocked",
        message: `Failed to start agent: ${message}`,
        metadata: { source: "system", phase: "start" },
      });
      throw new AgentError(`Failed to start agent: ${message}`, 500);
    }

    return (await this.getAgent(id)) as AgentRecord;
  }

  async getTerminalAccess(id: string): Promise<AgentTerminalAccess> {
    const agent = await this.getRequiredAgent(id);
    if (agent.status !== "running" && agent.status !== "creating") {
      throw new AgentError("Agent is not running.", 409);
    }

    if (this.config.agentRuntime === "inert") {
      return {
        mode: "inert",
        message:
          "Agent is running in inert mode. No tmux session or CLI process is attached in this environment.",
      };
    }

    if (!agent.tmuxSession) {
      throw new AgentError("Agent is missing tmux session metadata.", 500);
    }

    const hasSession = await this.runtime.hasSession(agent.tmuxSession);
    if (!hasSession) {
      await this.setAgentStatus(
        id,
        "stopped",
        "Agent tmux session is no longer running.",
        agent.tmuxSession
      );
      throw new AgentError(
        "Agent session is not available. Start the agent again.",
        409
      );
    }

    return { mode: "tmux", sessionName: agent.tmuxSession };
  }

  async stopAgent(
    id: string,
    input: StopAgentInput = {}
  ): Promise<AgentRecord> {
    const agent = await this.getRequiredAgent(id);
    const tmuxSession = agent.tmuxSession;
    const force = input.force ?? false;

    if (agent.status === "stopped") {
      return agent;
    }

    await this.setAgentStatus(id, "stopping", null, tmuxSession ?? undefined);

    // Run repo-defined stop hook (best-effort, non-blocking)
    await runLifecycleHook("stop", agent, this.logger).catch((err) =>
      this.logger.warn(
        { err, agentId: id },
        "Stop hook failed; continuing shutdown"
      )
    );

    try {
      if (tmuxSession && (await this.runtime.hasSession(tmuxSession))) {
        await this.runtime.stopSession(tmuxSession, force);
      }

      await this.setAgentStatus(id, "stopped", null, tmuxSession ?? undefined);
      await this.setSystemLatestEvent(id, {
        type: "idle",
        message: "Session stopped.",
      });

      // Harvest token usage from session logs (fire-and-forget)
      this.harvestAgentTokens(agent).catch((err) =>
        this.logger.warn({ err, agentId: id }, "Token harvest failed on stop")
      );
    } catch (error) {
      const message = errorMessage(error);
      await this.setAgentStatus(id, "error", message, tmuxSession ?? undefined);
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
    await writeLatestEvent(this.pool, this.logger, id, input);

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

  async upsertPin(id: string, pin: AgentPin): Promise<AgentRecord> {
    const current = await this.getAgent(id);
    if (!current) throw new AgentError("Agent not found.", 404);

    const pins = (current.pins ?? []).filter(
      (p) => p.label.toLowerCase() !== pin.label.toLowerCase()
    );
    if (pins.length >= MAX_PINS) {
      throw new AgentError(`Maximum of ${MAX_PINS} pins reached.`, 400);
    }
    pins.push(pin);

    await this.pool.query(
      `UPDATE agents SET pins = $2::jsonb, updated_at = NOW() WHERE id = $1`,
      [id, JSON.stringify(pins)]
    );

    return (await this.getAgent(id)) as AgentRecord;
  }

  async deletePin(id: string, label: string): Promise<AgentRecord> {
    const current = await this.getAgent(id);
    if (!current) throw new AgentError("Agent not found.", 404);

    const lowerLabel = label.toLowerCase();
    const pins = (current.pins ?? []).filter(
      (p) => p.label.toLowerCase() !== lowerLabel
    );

    await this.pool.query(
      `UPDATE agents SET pins = $2::jsonb, updated_at = NOW() WHERE id = $1`,
      [id, JSON.stringify(pins)]
    );

    return (await this.getAgent(id)) as AgentRecord;
  }

  async reconcileAgents(): Promise<void> {
    // Two passes: status reconciliation + orphan-session cleanup. The
    // SSE broadcaster doesn't need the changed-record list at this
    // entry point, so we drop the return value.
    await this.reconciler.reconcileAgentStatuses();
    await this.reconciler.cleanupOrphanedSessions();
  }

  /**
   * Status-only reconciliation pass — the historical contract. Returns
   * the records whose status the reconciler changed. Callers that want
   * the orphan-session cleanup too should call `reconcileAgents()`.
   */
  async reconcileAgentStatuses(): Promise<AgentRecord[]> {
    return this.reconciler.reconcileAgentStatuses();
  }

  async resolveRuntimeCwd(agent: AgentRecord): Promise<string> {
    const fallback = agent.cwd;
    const session = agent.tmuxSession?.trim();
    if (!session) return fallback;

    // Don't probe stopped/archived agents — their session may be gone
    // and the probe would just fall back to the agent's recorded cwd
    // anyway. Skip the runtime call to avoid the ~30ms ps/lsof chain.
    if (agent.status !== "running" && agent.status !== "creating") {
      return fallback;
    }

    // Runtime returns null when it can't determine the cwd; manager
    // applies the fallback policy here rather than letting the runtime
    // bake it into its return type.
    const cwd = await this.runtime.getCurrentCwd({
      sessionName: session,
      agentId: agent.id,
    });
    return cwd ?? fallback;
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

  // --- Persona Reviews ---

  async createPersonaReview(input: {
    agentId: string;
    parentAgentId: string;
    persona: string;
    lastReviewedCommit?: string | null;
  }): Promise<PersonaReviewRecord> {
    return personaReviews.createPersonaReview(this.pool, input);
  }

  async updatePersonaReviewStatus(
    agentId: string,
    input: { status: string; message?: string }
  ): Promise<PersonaReviewRecord> {
    return personaReviews.updatePersonaReviewStatus(this.pool, agentId, input);
  }

  async completePersonaReview(
    agentId: string,
    input: {
      verdict: string;
      summary: string;
      filesReviewed?: string[];
      message?: string;
      lastReviewedCommit?: string | null;
    }
  ): Promise<PersonaReviewRecord> {
    return personaReviews.completePersonaReview(this.pool, agentId, input);
  }

  async getPersonaReview(agentId: string): Promise<PersonaReviewRecord | null> {
    return personaReviews.getPersonaReview(this.pool, agentId);
  }

  async listRecentPersonaReviews(
    sinceDays: number
  ): Promise<PersonaReviewRecord[]> {
    return personaReviews.listRecentPersonaReviews(this.pool, sinceDays);
  }

  async listRecentFeedback(
    sinceDays: number
  ): Promise<Array<FeedbackRecord & { persona: string }>> {
    return feedbackQueries.listRecentFeedback(this.pool, sinceDays);
  }

  // --- Activity / History / Feedback Summaries ---

  async getActivitySummary(params: {
    start: Date;
    end: Date;
    project?: string;
  }): Promise<ActivitySummaryResult> {
    return telemetry.getActivitySummary(this.pool, params);
  }

  async getAgentHistory(params: {
    start: Date;
    end: Date;
    project?: string;
    limit: number;
    offset: number;
    includeEvents: boolean;
    includeFeedback: boolean;
    includeReviews: boolean;
    includeChildren: boolean;
  }): Promise<AgentHistoryResult> {
    return telemetry.getAgentHistory(this.pool, params);
  }

  async getFeedbackSummary(params: {
    start: Date;
    end: Date;
    project?: string;
    groupBy: "persona" | "severity" | "directory";
  }): Promise<FeedbackSummaryResult> {
    return telemetry.getFeedbackSummary(this.pool, params);
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

  // --- Feedback ---

  async submitFeedback(
    agentId: string,
    feedback: FeedbackInput
  ): Promise<FeedbackRecord> {
    return feedbackQueries.submitFeedback(this.pool, agentId, feedback);
  }

  async listFeedback(agentId: string): Promise<FeedbackRecord[]> {
    return feedbackQueries.listFeedback(this.pool, agentId);
  }

  async listFeedbackByParent(parentAgentId: string): Promise<FeedbackRecord[]> {
    return feedbackQueries.listFeedbackByParent(this.pool, parentAgentId);
  }

  async listFeedbackByParentGrouped(
    parentAgentId: string,
    persona?: string,
    limit = 100
  ): Promise<{
    personas: Array<{
      persona: string;
      agentId: string;
      feedback: FeedbackRecord[];
    }>;
  }> {
    return feedbackQueries.listFeedbackByParentGrouped(
      this.pool,
      parentAgentId,
      persona,
      limit
    );
  }

  async updateFeedbackStatus(
    feedbackId: number,
    agentId: string,
    status: "open" | "dismissed" | "forwarded" | "fixed" | "ignored",
    options: { reason?: string | null; resolutionCommit?: string | null } = {}
  ): Promise<FeedbackRecord | null> {
    return feedbackQueries.updateFeedbackStatus(
      this.pool,
      feedbackId,
      agentId,
      status,
      options
    );
  }

  async updateFeedbackStatusByParent(
    feedbackId: number,
    parentAgentId: string,
    status: "open" | "dismissed" | "forwarded" | "fixed" | "ignored",
    options: { reason?: string | null; resolutionCommit?: string | null } = {}
  ): Promise<FeedbackRecord | null> {
    return feedbackQueries.updateFeedbackStatusByParent(
      this.pool,
      feedbackId,
      parentAgentId,
      status,
      options
    );
  }

  async countFeedbackForAgent(agentId: string): Promise<number> {
    return feedbackQueries.countFeedbackForAgent(this.pool, agentId);
  }

  // --- Review Resolutions / Recheck ---

  async submitReviewResolution(input: {
    parentAgentId: string;
    personaAgentId: string;
    summary: string;
    resolutionCommit?: string | null;
  }): Promise<{
    review: PersonaReviewRecord;
    resolution: PersonaReviewResolutionRecord;
  }> {
    return personaReviews.submitReviewResolution(this.pool, input);
  }

  async getReviewResolutions(
    reviewId: number
  ): Promise<PersonaReviewResolutionRecord[]> {
    return personaReviews.getReviewResolutions(this.pool, reviewId);
  }

  async listResolvedFeedbackForRound(
    personaAgentId: string,
    roundNumber: number
  ): Promise<PersonaReviewResolutionItem[]> {
    return personaReviews.listResolvedFeedbackForRound(
      this.pool,
      personaAgentId,
      roundNumber
    );
  }

  async cancelReviewRecheck(input: {
    parentAgentId: string;
    personaAgentId: string;
    reason?: string | null;
  }): Promise<{ review: PersonaReviewRecord; transitioned: boolean }> {
    return personaReviews.cancelReviewRecheck(this.pool, input);
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
        persona_context AS "personaContext",
        review_agent_type AS "reviewAgentType",
        base_branch AS "baseBranch",
        template_id AS "templateId",
        auto_review AS "autoReview",
        cli_session_id AS "cliSessionId",
        (SELECT json_build_object(
           'status', pr.status,
           'message', pr.message,
           'verdict', pr.verdict,
           'summary', pr.summary,
           'filesReviewed', pr.files_reviewed,
           'roundNumber', pr.round_number,
           'updatedAt', pr.updated_at,
           'resolution', (
             SELECT json_build_object(
               'summary', prr.summary,
               'resolutionCommit', prr.resolution_commit,
               'submittedAt', prr.submitted_at,
               'roundNumber', prr.round_number
             )
             FROM persona_review_resolutions prr
             WHERE prr.review_id = pr.id
             ORDER BY prr.round_number DESC, prr.submitted_at DESC
             LIMIT 1
           )
         ) FROM persona_reviews pr WHERE pr.agent_id = agents.id LIMIT 1
        ) AS "review",
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
      stopAgent: (id, input) => this.stopAgent(id, input),
      harvestAgentTokens: (agent) => this.harvestAgentTokens(agent),
      setAgentStatus: (id, status, lastError, tmuxSession) =>
        this.setAgentStatus(id, status, lastError, tmuxSession),
      setArchivePhase: (id, phase) => this.setArchivePhase(id, phase),
    };
  }
}
