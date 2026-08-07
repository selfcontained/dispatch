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
  writeLatestEventIfCurrent,
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

type PreparedCreateInputs = {
  id: string;
  type: AgentType;
  role: AgentRole;
  name: string;
  originalCwd: string;
  tmuxSession: string;
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
    // Inert runtimes never launch CLI sessions, so there cannot be new token
    // usage to collect. Skipping also keeps inert dev/test servers from
    // scanning session history that belongs to the host environment.
    if (!this.runtime.tracksSessions()) return;

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
    const startupPrompt = buildStartupPrompt(
      input.initialPrompt,
      p.initialPins,
      initialMedia
    );

    if (this.config.agentRuntime === "inert") {
      await this.launchInertAgent({
        id: p.id,
        type: p.type,
        name: p.name,
        originalCwd: p.originalCwd,
        useWorktree: p.useWorktree,
        createNewBranch: p.createNewBranch,
        worktreeBranchName: p.worktreeBranchName,
        normalizedBaseBranch: p.normalizedBaseBranch,
        worktreePathOverride: p.worktreePathOverride,
      });
    } else {
      await this.launchWithSetupScript({
        id: p.id,
        type: p.type,
        role: p.role,
        name: p.name,
        originalCwd: p.originalCwd,
        tmuxSession: p.tmuxSession,
        mediaDir: p.mediaDir,
        agentArgs: p.agentArgs,
        model: p.model,
        fullAccess: p.fullAccess,
        useWorktree: p.useWorktree,
        createNewBranch: p.createNewBranch,
        worktreeBranchName: p.worktreeBranchName,
        normalizedBaseBranch: p.normalizedBaseBranch,
        worktreePathOverride: p.worktreePathOverride,
        cliSessionId: p.cliSessionId,
        startupPrompt,
        persona: input.persona,
        jobRunId: input.jobRunId,
        templateId: input.templateId,
        autoReview: input.autoReview ?? false,
      });
    }

    return (await this.getAgent(p.id)) as AgentRecord;
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
    const tmuxSession = toSessionName(this.config.sessionPrefix, id, name);
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

    const cliSessionId =
      input.cliSessionId ?? (type === "claude" ? randomUUID() : null);
    const initialSetupPhase: SetupPhase = useWorktree ? "worktree" : "session";

    return {
      id,
      type,
      role,
      name,
      originalCwd,
      tmuxSession,
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
      INSERT INTO agents (id, name, type, role, status, cwd, tmux_session, media_dir, codex_args, model, full_access, setup_phase, persona, parent_agent_id, persona_context, review_agent_type, cli_session_id, auto_review, base_branch, template_id, pins, updated_at)
      VALUES ($1, $2, $3, $4, 'creating', $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb, NOW())
      `,
      [
        p.id,
        p.name,
        p.type,
        p.role,
        p.originalCwd,
        p.tmuxSession,
        p.mediaDir,
        JSON.stringify(p.agentArgs),
        p.model ?? null,
        p.fullAccess,
        p.initialSetupPhase,
        input.persona ?? null,
        input.parentAgentId ?? null,
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

  private async launchInertAgent(opts: {
    id: string;
    type: AgentType;
    name: string;
    originalCwd: string;
    useWorktree: boolean;
    createNewBranch: boolean;
    worktreeBranchName: string | undefined;
    normalizedBaseBranch: string | undefined;
    worktreePathOverride: string | undefined;
  }): Promise<void> {
    const { id, type, name, originalCwd, useWorktree, createNewBranch } = opts;
    let effectiveCwd = originalCwd;
    let worktreePath: string | null = null;
    let worktreeBranch: string | null = null;

    if (useWorktree && opts.worktreeBranchName) {
      try {
        const result = await createGitWorktree({
          cwd: originalCwd,
          name,
          branchName: createNewBranch ? opts.worktreeBranchName : undefined,
          baseBranch: opts.normalizedBaseBranch,
          worktreePath: opts.worktreePathOverride,
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
        const message = error instanceof Error ? error.message : String(error);
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
    await this.populateGitContext(id);
    await this.setSystemLatestEvent(
      id,
      type === "terminal"
        ? { type: "idle", message: "Terminal session started." }
        : { type: "idle", message: "Session started." }
    );
  }

  private async launchWithSetupScript(opts: {
    id: string;
    type: AgentType;
    role: AgentRole;
    name: string;
    originalCwd: string;
    tmuxSession: string;
    mediaDir: string;
    agentArgs: string[];
    model: string | undefined;
    fullAccess: boolean;
    useWorktree: boolean;
    createNewBranch: boolean;
    worktreeBranchName: string | undefined;
    normalizedBaseBranch: string | undefined;
    worktreePathOverride: string | undefined;
    cliSessionId: string | null;
    startupPrompt: string | undefined;
    persona: string | undefined;
    jobRunId: string | undefined;
    templateId: string | undefined;
    autoReview: boolean;
  }): Promise<void> {
    const {
      id,
      type,
      role,
      name,
      originalCwd,
      tmuxSession,
      mediaDir,
      agentArgs,
      model,
      fullAccess,
      useWorktree,
      createNewBranch,
      cliSessionId,
      startupPrompt,
    } = opts;

    try {
      await this.runtime.ensureNoExistingSession(tmuxSession);

      const personality =
        opts.persona || opts.jobRunId || role === "assisted_update"
          ? null
          : await getActivePersonality(this.pool);

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
        opts.jobRunId,
        shouldSuggestSessionRename(name, id, {
          persona: opts.persona,
          jobRunId: opts.jobRunId,
          templateId: opts.templateId,
        }),
        !opts.persona && !opts.jobRunId && opts.autoReview,
        startupPrompt,
        personality?.prompt ?? null,
        model
      );

      const setupScript = generateSetupScript(this.config, {
        agentId: id,
        agentType: type,
        originalCwd,
        useWorktree,
        createNewBranch,
        worktreeBranchName: opts.worktreeBranchName,
        baseBranch: opts.normalizedBaseBranch,
        worktreePathOverride: opts.worktreePathOverride,
        agentName: name,
        agentCommand,
        jobRunId: opts.jobRunId,
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
        personality?.prompt ?? null,
        agent.model ?? undefined
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
      input
    );
    if (!updated) return null;

    const agent = await this.getAgent(id);
    if (!agent) return null;
    this.eventBus.publish(agent);
    void this.diffStatsRefresher?.signal(id);
    return agent;
  }

  async upsertPin(id: string, pin: AgentPin): Promise<AgentRecord> {
    await this.mutatePins(id, (currentPins) => {
      const existing = currentPins.find(
        (p) => p.label.toLowerCase() === pin.label.toLowerCase()
      );
      const pins = currentPins.filter(
        (p) => p.label.toLowerCase() !== pin.label.toLowerCase()
      );
      if (pins.length >= MAX_PINS) {
        throw new AgentError(`Maximum of ${MAX_PINS} pins reached.`, 400);
      }
      pins.push({ ...pin, id: existing?.id ?? pin.id ?? randomUUID() });
      return pins;
    });

    return (await this.getAgent(id)) as AgentRecord;
  }

  async deletePinById(id: string, pinId: string): Promise<AgentRecord> {
    await this.mutatePins(id, (currentPins) => {
      const pins = currentPins.filter((p) => p.id !== pinId);
      if (pins.length === currentPins.length) {
        throw new AgentError("Pin not found.", 404);
      }
      return pins;
    });

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
      const pins = mutate(result.rows[0]!.pins ?? []);
      await client.query(
        "UPDATE agents SET pins = $2::jsonb, updated_at = NOW() WHERE id = $1",
        [id, JSON.stringify(pins)]
      );
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
        persona_context AS "personaContext",
        review_agent_type AS "reviewAgentType",
        base_branch AS "baseBranch",
        template_id AS "templateId",
        auto_review AS "autoReview",
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
      stopAgent: (id, input) => this.stopAgent(id, input),
      harvestAgentTokens: (agent) => this.harvestAgentTokens(agent),
      setAgentStatus: (id, status, lastError, tmuxSession) =>
        this.setAgentStatus(id, status, lastError, tmuxSession),
      setArchivePhase: (id, phase) => this.setArchivePhase(id, phase),
    };
  }
}
