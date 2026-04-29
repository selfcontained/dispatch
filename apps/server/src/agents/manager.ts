import { randomUUID } from "node:crypto";
import {
  appendFile,
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";

import type { AppConfig } from "../config.js";
import {
  assertSafeRefName,
  cleanupGitWorktree,
  createGitWorktree,
  GitWorktreeError,
  worktreePathSlug,
} from "../shared/git/worktree.js";
import { runCommand } from "../shared/lib/run-command.js";
import { loadRepoHooks } from "../shared/mcp/repo-tools.js";
import { harvestTokenUsage } from "./token-harvester.js";
import { AgentError } from "./errors.js";
import {
  buildAgentCommand,
  buildStartupPrompt,
} from "./tmux/command-builder.js";
import {
  agentIdFromSessionName,
  shouldSuggestSessionRename,
  toSessionName,
} from "./tmux/session-name.js";
import { generateSetupScript } from "./tmux/setup-script.js";
import type {
  AgentGitContext,
  AgentLatestEventInput,
  AgentLatestEventType,
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
  ReviewerRecheckContext,
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
  ReviewerRecheckContext,
} from "./persona-reviews.js";
export { resolveProgressPingStatus } from "./persona-reviews.js";
export type { FeedbackInput, FeedbackRecord } from "./feedback.js";

const CODEX_FULL_ACCESS_ARG = "--dangerously-bypass-approvals-and-sandbox";
const CLAUDE_FULL_ACCESS_ARG = "--dangerously-skip-permissions";

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
};

type StopAgentInput = {
  force?: boolean;
};

export class AgentManager {
  private static readonly TMUX_INVENTORY_INTERVAL_MS = 60_000;
  private static readonly LOG_MAINTENANCE_INTERVAL_MS = 5 * 60_000;
  private static readonly MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
  private static readonly DIAGNOSTICS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  private static readonly SERVER_LOG_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
  private readonly pool: Pool;
  private readonly logger: FastifyBaseLogger;
  private readonly config: AppConfig;
  private readonly runtimeCwdCache = new Map<
    string,
    { value: string; expiresAt: number }
  >();
  private readonly eventListeners: AgentEventListener[] = [];
  private lastTmuxInventoryAt = 0;
  private lastLogMaintenanceAt = 0;

  constructor(pool: Pool, logger: FastifyBaseLogger, config: AppConfig) {
    this.pool = pool;
    this.logger = logger;
    this.config = config;
  }

  /** Register a callback invoked after every upsertLatestEvent. */
  onLatestEvent(listener: AgentEventListener): void {
    this.eventListeners.push(listener);
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
    const initialPins = input.initialPins ?? [];

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
      INSERT INTO agents (id, name, type, role, status, cwd, tmux_session, media_dir, codex_args, full_access, setup_phase, persona, parent_agent_id, persona_context, review_agent_type, cli_session_id, auto_review, base_branch, pins, updated_at)
      VALUES ($1, $2, $3, $4, 'creating', $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, NOW())
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
        JSON.stringify(initialPins),
      ]
    );

    let initialMedia: Array<{
      fileName: string;
      displayName: string;
      source: string;
      description: string | null;
    }> = [];
    if (input.initialFiles && input.initialFiles.length > 0) {
      try {
        initialMedia = await this.seedInitialMedia(
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
          await this.setupWorktree(originalCwd, worktreePath);
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
      await this.setSystemLatestEvent(
        id,
        type === "terminal"
          ? { type: "idle", message: "Terminal session started." }
          : { type: "working", message: "Session started." }
      );
    } else {
      try {
        await this.ensureNoExistingSession(tmuxSession);

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
          }),
          !input.persona && !input.jobRunId && (input.autoReview ?? false),
          startupPrompt
        );
        const exitFile = `/tmp/dispatch_${tmuxSession}.exit`;

        // Generate a setup script that handles worktree creation, env copy,
        // dep install, and then exec's into the agent CLI — all visible in the terminal.
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
          exitFile,
          jobRunId: input.jobRunId,
        });

        const setupScriptPath = `/tmp/dispatch_setup_${id}.sh`;
        await writeFile(setupScriptPath, setupScript, { mode: 0o755 });

        // Start tmux running the setup script — the frontend can connect immediately
        await runCommand("tmux", [
          "new-session",
          "-d",
          "-s",
          tmuxSession,
          "-c",
          originalCwd,
          `bash ${setupScriptPath}`,
        ]);
        await runCommand(
          "tmux",
          ["set-option", "-t", tmuxSession, "status", "off"],
          {
            allowedExitCodes: [0, 1],
          }
        );
        await runCommand(
          "tmux",
          ["set-option", "-t", tmuxSession, "allow-passthrough", "on"],
          {
            allowedExitCodes: [0, 1],
          }
        );
        await runCommand(
          "tmux",
          ["set-option", "-as", "terminal-features", "xterm-256color:sync"],
          {
            allowedExitCodes: [0, 1],
          }
        );

        if (!(await this.hasAgentSession(tmuxSession))) {
          const detail = await this.readSetupLogTail(id);
          throw new Error(
            `tmux session exited immediately after launch${detail}`
          );
        }
      } catch (error) {
        const message = this.errorMessage(error);
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

    await this.setSystemLatestEvent(
      id,
      agent.type === "terminal"
        ? { type: "idle", message: "Terminal session started." }
        : { type: "working", message: "Session started." }
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
    const hasSession = await this.hasAgentSession(tmuxSession);

    if (hasSession) {
      await this.setAgentStatus(id, "running", null, tmuxSession);
      await this.setSystemLatestEvent(id, {
        type: "working",
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
      await this.startAgentSession(
        id,
        tmuxSession,
        agent.cwd,
        agent.mediaDir ?? this.defaultMediaDir(id),
        agent.name,
        agent.persona,
        agent.type,
        agent.role,
        agent.agentArgs ?? [],
        agent.fullAccess ?? false,
        cliSessionId ?? undefined,
        shouldResume,
        agent.autoReview ?? false
      );
      await this.setAgentStatus(id, "running", null, tmuxSession);
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
              type: "working",
              message: shouldResume ? "Session resumed." : "Session started.",
            }
      );
    } catch (error) {
      const message = this.errorMessage(error);
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

    if (!agent.tmuxSession) {
      throw new AgentError("Agent is missing tmux session metadata.", 500);
    }

    if (this.config.agentRuntime === "inert") {
      return {
        mode: "inert",
        message:
          "Agent is running in inert mode. No tmux session or CLI process is attached in this environment.",
      };
    }

    const hasSession = await this.hasAgentSession(agent.tmuxSession);
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
    await this.runLifecycleHook("stop", agent).catch((err) =>
      this.logger.warn(
        { err, agentId: id },
        "Stop hook failed; continuing shutdown"
      )
    );

    try {
      if (tmuxSession && (await this.hasAgentSession(tmuxSession))) {
        await this.stopAgentSession(tmuxSession, force);
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
      const message = this.errorMessage(error);
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

  /**
   * Fast, synchronous first phase of archival: validates state and marks agent as archiving.
   * Returns the updated agent record for SSE broadcast.
   */
  async beginArchive(
    id: string,
    cleanupWorktree: WorktreeCleanupMode = "auto"
  ): Promise<AgentRecord> {
    // Atomic transition: only one caller can move out of non-archiving state.
    // This prevents TOCTOU races when concurrent DELETE requests hit the same agent.
    const result = await this.pool.query(
      `UPDATE agents
       SET status = 'archiving', archive_phase = 'stopping', archive_cleanup_mode = $2, updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL AND status != 'archiving'
       RETURNING id`,
      [id, cleanupWorktree]
    );

    if (result.rowCount === 0) {
      // Either the agent doesn't exist, is already deleted, or is already archiving
      const existing = await this.getAgent(id);
      if (!existing) {
        throw new AgentError("Agent not found.", 404);
      }
      throw new AgentError("Agent is already being archived.", 409);
    }

    return await this.getRequiredAgent(id);
  }

  /**
   * Long-running second phase of archival: stops agent, cleans up worktree, soft-deletes.
   * Designed to run fire-and-forget after beginArchive returns.
   */
  async executeArchive(
    id: string,
    callbacks: {
      onPhaseChange: (agent: AgentRecord) => void;
      onComplete: (deletedIds: string[]) => void;
      onError: (error: unknown) => void;
    }
  ): Promise<void> {
    const deleteStart = Date.now();
    const durations: Record<string, number> = {};

    try {
      const agent = await this.getRequiredAgent(id);
      const cleanupWorktree = agent.archiveCleanupMode ?? "auto";

      // Phase: stopping — tear down session without changing agent status
      const t = Date.now();
      try {
        await this.runLifecycleHook("stop", agent).catch((err) =>
          this.logger.warn(
            { err, agentId: id },
            "Stop hook failed during archive; continuing"
          )
        );
        if (
          agent.tmuxSession &&
          (await this.hasAgentSession(agent.tmuxSession))
        ) {
          await this.stopAgentSession(agent.tmuxSession, true);
        }
        this.harvestAgentTokens(agent).catch((err) =>
          this.logger.warn(
            { err, agentId: id },
            "Token harvest failed during archive"
          )
        );
      } catch (err) {
        this.logger.warn(
          { err, agentId: id },
          "Stop during archive failed; continuing"
        );
      }
      durations.stop = Date.now() - t;

      const publishPhase = async (phase: ArchivePhase) => {
        await this.setArchivePhase(id, phase);
        const updated = await this.getAgent(id);
        if (updated) callbacks.onPhaseChange(updated);
      };

      // Phase: worktree-check
      await publishPhase("worktree-check");

      if (agent.worktreePath) {
        try {
          const tCheck = Date.now();
          let shouldCleanup = cleanupWorktree === "force";
          let preserveReason: string | undefined;

          if (!shouldCleanup && cleanupWorktree === "auto") {
            const [unmerged, uncommitted] = await Promise.all([
              this.getUnmergedChanges(agent.worktreePath),
              this.getUncommittedChanges(agent.worktreePath),
            ]);
            const hasChanges =
              unmerged.hasUnmergedCommits || uncommitted.hasUncommittedChanges;
            shouldCleanup = !hasChanges;
            if (hasChanges) {
              const reasons: string[] = [];
              if (unmerged.hasUnmergedCommits)
                reasons.push(
                  `${unmerged.changedFiles.length} unmerged file(s)`
                );
              if (uncommitted.hasUncommittedChanges)
                reasons.push(
                  `${uncommitted.uncommittedFiles.length} uncommitted file(s)`
                );
              preserveReason = reasons.join(", ");
            }
          } else if (!shouldCleanup && cleanupWorktree === "keep") {
            preserveReason = "user chose keep";
          }
          durations.outstandingChangesCheck = Date.now() - tCheck;

          if (shouldCleanup) {
            // Phase: worktree-cleanup
            await publishPhase("worktree-cleanup");

            const tCleanup = Date.now();
            // If the worktree is on the user's original starting branch
            // (i.e. no dispatch-created branch), don't delete that branch —
            // it belongs to the user, not to this agent.
            const dispatchOwnsBranch =
              !!agent.worktreeBranch &&
              (!agent.baseBranch || agent.worktreeBranch !== agent.baseBranch);
            await cleanupGitWorktree({
              cwd: agent.worktreePath,
              deleteBranch: dispatchOwnsBranch,
              force: true,
            });
            durations.worktreeCleanup = Date.now() - tCleanup;
            this.logger.info(
              { agentId: id, worktreePath: agent.worktreePath },
              "Cleaned up agent worktree."
            );
          } else {
            this.logger.info(
              {
                agentId: id,
                worktreePath: agent.worktreePath,
                cleanupWorktree,
                preserveReason,
              },
              `Preserved agent worktree: ${preserveReason}.`
            );
          }
        } catch (error) {
          this.logger.warn(
            { err: error, agentId: id },
            "Worktree cleanup failed; leaving on disk."
          );
        }
      }

      // Phase: finalizing
      await publishPhase("finalizing");

      const tDb = Date.now();
      await this.pool
        .query(
          `INSERT INTO agent_events (agent_id, event_type, message, metadata, agent_type, agent_name, project_dir)
           SELECT $1, 'idle', 'Agent deleted.', '{"source":"system"}'::jsonb, type, name, COALESCE(git_context->>'repoRoot', cwd)
           FROM agents WHERE id = $1`,
          [id]
        )
        .catch((err) =>
          this.logger.warn({ err }, "Failed to insert delete event")
        );

      await this.pool.query(
        "UPDATE agents SET deleted_at = NOW(), archive_phase = NULL, archive_cleanup_mode = NULL, updated_at = NOW() WHERE id = $1",
        [id]
      );
      durations.db = Date.now() - tDb;

      // Cascade: archive child agents (persona agents spawned by this parent)
      const tCascade = Date.now();
      const children = await this.pool.query<{ id: string }>(
        "SELECT id FROM agents WHERE parent_agent_id = $1 AND deleted_at IS NULL",
        [id]
      );
      for (const child of children.rows) {
        try {
          await this.deleteAgentDirect(child.id, true, cleanupWorktree);
        } catch (err) {
          this.logger.warn(
            { err, childId: child.id, parentId: id },
            "Failed to cascade-delete child agent"
          );
        }
      }
      if (children.rows.length > 0) {
        durations.cascadeChildren = Date.now() - tCascade;
      }

      durations.total = Date.now() - deleteStart;
      const parts = Object.entries(durations)
        .map(([k, v]) => `${k}=${v}ms`)
        .join(", ");
      this.logger.info(
        { agentId: id, durations },
        `Archive durations: ${parts}`
      );

      const deletedIds = [id, ...children.rows.map((r) => r.id)];
      callbacks.onComplete(deletedIds);
    } catch (error) {
      this.logger.error({ err: error, agentId: id }, "Archive failed");
      try {
        await this.setAgentStatus(
          id,
          "error",
          error instanceof Error ? error.message : "Archive failed"
        );
        await this.setArchivePhase(id, null);
      } catch {
        /* best effort */
      }
      callbacks.onError(error);
    }
  }

  /**
   * Synchronous delete for child/cascade agents (no worktree, fast).
   */
  private async deleteAgentDirect(
    id: string,
    force = false,
    cleanupWorktree: WorktreeCleanupMode = "auto"
  ): Promise<void> {
    const deleteStart = Date.now();
    const durations: Record<string, number> = {};
    const agent = await this.getRequiredAgent(id);
    const sessionExists = agent.tmuxSession
      ? await this.hasAgentSession(agent.tmuxSession)
      : false;

    if (agent.status === "running" && sessionExists && !force) {
      throw new AgentError(
        "Agent is running. Stop it first or use force delete.",
        409
      );
    }

    if (agent.status !== "stopped") {
      const t = Date.now();
      try {
        await this.stopAgent(id, { force: true });
      } catch (err) {
        this.logger.warn(
          { err, agentId: id },
          "Stop during delete failed; continuing with deletion"
        );
      }
      durations.stop = Date.now() - t;
    }

    const tDb = Date.now();
    await this.pool
      .query(
        `INSERT INTO agent_events (agent_id, event_type, message, metadata, agent_type, agent_name, project_dir)
         SELECT $1, 'idle', 'Agent deleted.', '{"source":"system"}'::jsonb, type, name, COALESCE(git_context->>'repoRoot', cwd)
         FROM agents WHERE id = $1`,
        [id]
      )
      .catch((err) =>
        this.logger.warn({ err }, "Failed to insert delete event")
      );

    await this.pool.query(
      "UPDATE agents SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1",
      [id]
    );
    durations.db = Date.now() - tDb;

    // Cascade to any children (recursive to handle multi-level nesting)
    const children = await this.pool.query<{ id: string }>(
      "SELECT id FROM agents WHERE parent_agent_id = $1 AND deleted_at IS NULL",
      [id]
    );
    for (const child of children.rows) {
      try {
        await this.deleteAgentDirect(child.id, true, cleanupWorktree);
      } catch (err) {
        this.logger.warn(
          { err, childId: child.id, parentId: id },
          "Failed to cascade-delete child agent"
        );
      }
    }

    durations.total = Date.now() - deleteStart;
    const parts = Object.entries(durations)
      .map(([k, v]) => `${k}=${v}ms`)
      .join(", ");
    this.logger.info({ agentId: id, durations }, `Archive durations: ${parts}`);
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

    let branchName: string | null = null;
    let hasUnmergedCommits = false;
    let hasUncommittedChanges = false;
    let changedFiles: string[] = [];
    let uncommittedFiles: string[] = [];

    try {
      const branchResult = await runCommand(
        "git",
        ["-C", agent.worktreePath, "symbolic-ref", "--short", "-q", "HEAD"],
        { allowedExitCodes: [0, 1] }
      );
      branchName =
        branchResult.exitCode === 0 && branchResult.stdout
          ? branchResult.stdout
          : null;
      const [unmerged, uncommitted] = await Promise.all([
        this.getUnmergedChanges(agent.worktreePath),
        this.getUncommittedChanges(agent.worktreePath),
      ]);
      hasUnmergedCommits = unmerged.hasUnmergedCommits;
      changedFiles = unmerged.changedFiles;
      hasUncommittedChanges = uncommitted.hasUncommittedChanges;
      uncommittedFiles = uncommitted.uncommittedFiles;
    } catch {
      // Worktree may have been manually removed
    }

    return {
      hasWorktree: true,
      hasUnmergedCommits,
      hasUncommittedChanges,
      worktreePath: agent.worktreePath,
      branchName,
      changedFiles,
      uncommittedFiles,
    };
  }

  async upsertLatestEvent(
    id: string,
    input: AgentLatestEventInput
  ): Promise<AgentRecord> {
    const message = input.message.trim();
    if (!message) {
      throw new AgentError(
        "Latest event message must be a non-empty string.",
        400
      );
    }

    const result = await this.pool.query(
      `
      UPDATE agents
      SET latest_event_type = $2,
          latest_event_message = $3,
          latest_event_metadata = $4::jsonb,
          latest_event_updated_at = NOW(),
          updated_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL
      `,
      [id, input.type, message, JSON.stringify(input.metadata ?? {})]
    );

    if (result.rowCount !== 1) {
      throw new AgentError("Agent not found.", 404);
    }

    // Append to event history (fire-and-forget)
    this.pool
      .query(
        `INSERT INTO agent_events (agent_id, event_type, message, metadata, agent_type, agent_name, project_dir)
         SELECT $1, $2, $3, $4::jsonb, type, name, COALESCE(git_context->>'repoRoot', cwd)
         FROM agents WHERE id = $1`,
        [id, input.type, message, JSON.stringify(input.metadata ?? {})]
      )
      .catch((err) =>
        this.logger.warn({ err }, "Failed to insert agent event history")
      );

    // Agent could be soft-deleted between the UPDATE and this SELECT in rare races.
    // Guard against null to prevent downstream crashes (e.g. in event listeners).
    const agent = await this.getAgent(id);
    if (!agent) {
      throw new AgentError("Agent not found.", 404);
    }
    for (const listener of this.eventListeners) {
      try {
        listener(agent);
      } catch (err) {
        this.logger.warn({ err }, "Agent event listener threw");
      }
    }
    return agent;
  }

  async upsertPin(id: string, pin: AgentPin): Promise<AgentRecord> {
    const MAX_PINS = 50;
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
    await this.reconcileAgentStatuses();
    if (this.config.agentRuntime === "tmux") {
      await this.cleanupOrphanedSessions();
    }
  }

  async reconcileAgentStatuses(): Promise<AgentRecord[]> {
    await this.maybeCaptureTmuxInventory();
    await this.maybeMaintenanceLogs();

    const result = await this.pool.query(
      "SELECT id, tmux_session AS \"tmuxSession\", status, updated_at AS \"updatedAt\" FROM agents WHERE deleted_at IS NULL AND status IN ('running', 'stopping', 'creating', 'archiving')"
    );

    const reconciled: AgentRecord[] = [];

    for (const row of result.rows as Array<{
      id: string;
      tmuxSession: string | null;
      status: string;
      updatedAt: string;
    }>) {
      // Archiving agents are handled separately — only resume if stuck for > 30s
      if (row.status === "archiving") {
        const stuckSeconds =
          (Date.now() - new Date(row.updatedAt).getTime()) / 1000;
        if (stuckSeconds > 30) {
          this.logger.info(
            { id: row.id, stuckSeconds },
            "Found agent stuck in archiving state — will be resumed"
          );
          const agent = await this.getAgent(row.id);
          if (agent) {
            reconciled.push(agent);
          }
        }
        continue;
      }

      const exists = row.tmuxSession
        ? await this.hasAgentSession(row.tmuxSession)
        : false;

      if (!exists) {
        const exitInfo =
          this.config.agentRuntime === "tmux" && row.tmuxSession
            ? await this.readExitFile(row.tmuxSession)
            : null;
        if (this.config.agentRuntime === "tmux" && row.tmuxSession) {
          await this.captureMissingSessionIncident({
            agentId: row.id,
            tmuxSession: row.tmuxSession,
            status: row.status,
            updatedAt: row.updatedAt,
            exitInfo,
          });
        }
        if (exitInfo !== null) {
          this.logger.info(
            { id: row.id, exitCode: exitInfo },
            "Agent process exited with code %d",
            exitInfo
          );
        }
        const setupLogTail = await this.readSetupLogTail(row.id);
        const errorDetail = setupLogTail || null;
        const launchFailed =
          row.status === "creating" || (exitInfo !== null && exitInfo !== 0);
        const nextStatus: AgentStatus = launchFailed ? "error" : "stopped";
        const baseMessage = launchFailed
          ? row.status === "creating"
            ? exitInfo !== null
              ? `Launch failed with exit code ${exitInfo}.`
              : "Launch failed before the session became ready."
            : exitInfo !== null
              ? `Session exited with code ${exitInfo}.`
              : "Session ended unexpectedly."
          : "Session ended normally.";
        await this.setAgentStatus(
          row.id,
          nextStatus,
          errorDetail,
          row.tmuxSession ?? undefined
        );
        await this.setSystemLatestEvent(row.id, {
          type: launchFailed ? "blocked" : "idle",
          message: setupLogTail
            ? `${baseMessage}\n${setupLogTail}`
            : baseMessage,
          metadata: {
            source: "system",
            ...(exitInfo !== null ? { exitCode: exitInfo } : {}),
            launchFailed,
          },
        });
        const agent = await this.getAgent(row.id);
        if (agent) {
          reconciled.push(agent);
        }
      } else if (row.status === "stopping") {
        const STUCK_STOPPING_TIMEOUT_S = 60;
        const stuckSeconds =
          (Date.now() - new Date(row.updatedAt).getTime()) / 1000;
        if (stuckSeconds > STUCK_STOPPING_TIMEOUT_S) {
          this.logger.warn(
            { id: row.id, stuckSeconds },
            "Agent stuck in stopping state, reverting to running"
          );
          await this.setAgentStatus(
            row.id,
            "running",
            null,
            row.tmuxSession ?? undefined
          );
          await this.setSystemLatestEvent(row.id, {
            type: "working",
            message:
              "Stop timed out — agent reverted to running. Try force stop.",
            metadata: { source: "system" },
          });
          const agent = await this.getAgent(row.id);
          if (agent) {
            reconciled.push(agent);
          }
        }
      }
    }

    return reconciled;
  }

  private async cleanupOrphanedSessions(): Promise<void> {
    const SESSION_PREFIX = `${this.config.sessionPrefix}_agt_`;

    let stdout: string | undefined;
    try {
      const result = await runCommand(
        "tmux",
        ["list-sessions", "-F", "#{session_name}:#{session_created}"],
        {
          allowedExitCodes: [0, 1],
        }
      );
      stdout = result.stdout;
    } catch {
      // tmux not running or no sessions
      return;
    }

    if (!stdout?.trim()) return;

    const sessions = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const colonIdx = line.lastIndexOf(":");
        const name = line.substring(0, colonIdx);
        const createdStr = line.substring(colonIdx + 1);
        return { name, createdAt: parseInt(createdStr, 10) };
      })
      .filter((s) => s.name.startsWith(SESSION_PREFIX));

    if (sessions.length === 0) return;

    // Extract agent IDs from session names
    const agentIds = sessions.map((s) => agentIdFromSessionName(s.name));

    // Query DB for these agent IDs
    const placeholders = agentIds.map((_, i) => `$${i + 1}`).join(", ");
    const dbResult = await this.pool.query(
      `SELECT id, status FROM agents WHERE deleted_at IS NULL AND id IN (${placeholders})`,
      agentIds
    );
    const dbAgents = new Map<string, string>();
    for (const row of dbResult.rows as Array<{ id: string; status: string }>) {
      dbAgents.set(row.id, row.status);
    }

    const ORPHAN_AGE_THRESHOLD_S = 300;
    const now = Math.floor(Date.now() / 1000);
    const toKill: string[] = [];

    for (const session of sessions) {
      const agentId = agentIdFromSessionName(session.name);
      const status = dbAgents.get(agentId);

      // Agent in terminal state — session is definitely orphaned
      if (status === "stopped" || status === "error") {
        this.logger.info(
          { session: session.name, agentId, status },
          "Killing orphaned tmux session (agent in terminal state)"
        );
        toKill.push(session.name);
        continue;
      }

      // No DB record — leave it alone. The session may belong to another
      // server instance using the same tmux namespace. Only clean up
      // sessions that *this* database definitively knows about.
      if (!status) {
        this.logger.debug(
          { session: session.name, agentId },
          "Ignoring tmux session with no matching DB record"
        );
      }
    }

    await Promise.all(
      toKill.map((name) =>
        runCommand("tmux", ["kill-session", "-t", name]).catch(() => {})
      )
    );
  }

  private diagnosticsRoot(): string {
    return path.join(os.homedir(), ".dispatch", "diagnostics");
  }

  private async maybeCaptureTmuxInventory(): Promise<void> {
    const now = Date.now();
    if (
      now - this.lastTmuxInventoryAt <
      AgentManager.TMUX_INVENTORY_INTERVAL_MS
    ) {
      return;
    }
    this.lastTmuxInventoryAt = now;

    try {
      await mkdir(this.diagnosticsRoot(), { recursive: true });
      const payload = {
        capturedAt: new Date(now).toISOString(),
        source: "reconcile",
        tmux: {
          serverPid: await this.detectTmuxServerPid(),
          sessions: await this.captureCommand(
            "tmux",
            ["list-sessions", "-F", "#{session_name}:#{session_created}"],
            [0, 1]
          ),
          panes: await this.captureCommand(
            "tmux",
            [
              "list-panes",
              "-a",
              "-F",
              "#{session_name}:#{window_name}:#{pane_id}:#{pane_pid}:#{pane_current_command}",
            ],
            [0, 1]
          ),
        },
      };
      await appendFile(
        path.join(this.diagnosticsRoot(), "tmux-inventory.jsonl"),
        `${JSON.stringify(payload)}\n`,
        "utf-8"
      );
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to capture tmux inventory.");
    }
  }

  private async captureMissingSessionIncident(input: {
    agentId: string;
    tmuxSession: string;
    status: string;
    updatedAt: string;
    exitInfo: number | null;
  }): Promise<void> {
    try {
      await mkdir(this.diagnosticsRoot(), { recursive: true });
      const capturedAt = new Date().toISOString();
      const safeTs = capturedAt.replaceAll(":", "-");
      const payload = {
        capturedAt,
        incident: "missing_tmux_session",
        agent: input,
        tmux: {
          serverPid: await this.detectTmuxServerPid(),
          sessions: await this.captureCommand(
            "tmux",
            ["list-sessions", "-F", "#{session_name}:#{session_created}"],
            [0, 1]
          ),
          panes: await this.captureCommand(
            "tmux",
            [
              "list-panes",
              "-a",
              "-F",
              "#{session_name}:#{window_name}:#{pane_id}:#{pane_pid}:#{pane_current_command}",
            ],
            [0, 1]
          ),
        },
        processes: await this.captureCommand(
          "ps",
          ["-axo", "pid,ppid,pgid,user,command"],
          [0]
        ),
        launchctl: await this.captureCommand(
          "launchctl",
          ["print", `gui/${process.getuid?.() ?? -1}/com.dispatch.server`],
          [0, 113]
        ),
      };
      const fileName = `${safeTs}-missing-session-${input.agentId}.json`;
      await writeFile(
        path.join(this.diagnosticsRoot(), fileName),
        JSON.stringify(payload, null, 2),
        "utf-8"
      );
    } catch (error) {
      this.logger.warn(
        { err: error, agentId: input.agentId },
        "Failed to capture missing tmux session incident."
      );
    }
  }

  private async maybeMaintenanceLogs(): Promise<void> {
    const now = Date.now();
    if (
      now - this.lastLogMaintenanceAt <
      AgentManager.LOG_MAINTENANCE_INTERVAL_MS
    ) {
      return;
    }
    this.lastLogMaintenanceAt = now;

    try {
      // Rotate tmux-inventory.jsonl (keep 1 backup)
      const inventoryPath = path.join(
        this.diagnosticsRoot(),
        "tmux-inventory.jsonl"
      );
      await this.rotateFile(inventoryPath, 1);

      // Rotate dispatch.log via copytruncate (keep 3 backups)
      const serverLogPath = path.join(
        os.homedir(),
        ".dispatch",
        "logs",
        "dispatch.log"
      );
      await this.copyTruncateFile(serverLogPath, 3);

      // Delete old diagnostics JSON files (> 7 days)
      await this.deleteOldFiles(
        this.diagnosticsRoot(),
        /\.json$/,
        AgentManager.DIAGNOSTICS_MAX_AGE_MS
      );

      // Delete old rotated logs (inventory backups > 7 days, server log backups > 14 days)
      await this.deleteOldFiles(
        this.diagnosticsRoot(),
        /tmux-inventory\.jsonl\.\d+$/,
        AgentManager.DIAGNOSTICS_MAX_AGE_MS
      );
      await this.deleteOldFiles(
        path.join(os.homedir(), ".dispatch", "logs"),
        /dispatch\.log\.\d+$/,
        AgentManager.SERVER_LOG_MAX_AGE_MS
      );
    } catch (error) {
      this.logger.warn({ err: error }, "Log maintenance failed.");
    }
  }

  /** Rotate by renaming: file -> file.1, file.1 -> file.2, etc. */
  private async rotateFile(
    filePath: string,
    maxBackups: number
  ): Promise<void> {
    try {
      const s = await stat(filePath);
      if (s.size < AgentManager.MAX_LOG_SIZE_BYTES) return;
    } catch {
      return;
    } // file doesn't exist

    // Shift existing backups
    for (let i = maxBackups; i >= 1; i--) {
      const src = i === 1 ? filePath : `${filePath}.${i - 1}`;
      const dst = `${filePath}.${i}`;
      try {
        await rename(src, dst);
      } catch {
        /* missing, skip */
      }
    }
  }

  /** Copy then truncate in-place (preserves open file descriptors like launchd's). */
  private async copyTruncateFile(
    filePath: string,
    maxBackups: number
  ): Promise<void> {
    try {
      const s = await stat(filePath);
      if (s.size < AgentManager.MAX_LOG_SIZE_BYTES) return;
    } catch {
      return;
    }

    // Shift existing backups
    for (let i = maxBackups; i >= 2; i--) {
      try {
        await rename(`${filePath}.${i - 1}`, `${filePath}.${i}`);
      } catch {
        /* missing */
      }
    }

    // Copy current to .1, then truncate in place.
    // Small data-loss window between copy and truncate (same as logrotate copytruncate). Acceptable for diagnostic logs.
    await copyFile(filePath, `${filePath}.1`);
    const fh = await open(filePath, "r+");
    try {
      await fh.truncate(0);
    } finally {
      await fh.close();
    }
  }

  /** Delete files matching a pattern that are older than maxAgeMs. */
  private async deleteOldFiles(
    dir: string,
    pattern: RegExp,
    maxAgeMs: number
  ): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }

    const now = Date.now();
    for (const entry of entries) {
      if (!pattern.test(entry)) continue;
      const filePath = path.join(dir, entry);
      try {
        const s = await stat(filePath);
        if (now - s.mtimeMs > maxAgeMs) {
          await unlink(filePath);
        }
      } catch {
        /* already gone or inaccessible */
      }
    }
  }

  private async detectTmuxServerPid(): Promise<number | null> {
    const processes = await this.captureCommand(
      "ps",
      ["-axo", "pid=,comm="],
      [0]
    );
    if (processes.exitCode !== 0) {
      return null;
    }
    const pidLine = processes.stdout
      .split("\n")
      .map((line) => line.trim())
      .find((line) => /\btmux$/.test(line));
    if (!pidLine) {
      return null;
    }
    const [pidText] = pidLine.split(/\s+/, 1);
    const pid = Number(pidText);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  }

  private async captureCommand(
    command: string,
    args: string[],
    allowedExitCodes: number[]
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    try {
      return await runCommand(command, args, { allowedExitCodes });
    } catch (error) {
      return {
        exitCode: -1,
        stdout: "",
        stderr: this.errorMessage(error),
      };
    }
  }

  async resolveRuntimeCwd(agent: AgentRecord): Promise<string> {
    const fallback = agent.cwd;
    const session = agent.tmuxSession?.trim();
    if (!session || this.config.agentRuntime !== "tmux") {
      return fallback;
    }

    if (agent.status !== "running" && agent.status !== "creating") {
      return fallback;
    }

    const cacheKey = `${agent.id}:${session}`;
    const cached = this.runtimeCwdCache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    try {
      // First, try to resolve the CWD from the agent CLI process itself.
      // tmux pane_current_path only tracks the shell's CWD, but agent CLIs
      // (claude, codex, opencode) may cd internally without updating the shell.
      const agentCwd = await this.resolveAgentProcessCwd(session);
      if (agentCwd) {
        this.runtimeCwdCache.set(cacheKey, {
          value: agentCwd,
          expiresAt: now + 10_000,
        });
        return agentCwd;
      }

      // Fall back to tmux pane_current_path (the shell's CWD).
      const result = await runCommand(
        "tmux",
        ["display-message", "-p", "-t", session, "#{pane_current_path}"],
        {
          allowedExitCodes: [0, 1],
          timeoutMs: 800,
        }
      );
      const cwd = result.stdout.trim();
      if (result.exitCode !== 0 || !cwd) {
        return fallback;
      }
      this.runtimeCwdCache.set(cacheKey, {
        value: cwd,
        expiresAt: now + 10_000,
      });
      return cwd;
    } catch {
      return fallback;
    }
  }

  /**
   * Resolve the CWD of the agent CLI process (claude/codex/opencode) running
   * inside a tmux pane. The CLI process may have cd'd into a worktree
   * internally, which tmux's pane_current_path won't reflect.
   */
  private async resolveAgentProcessCwd(
    session: string
  ): Promise<string | null> {
    try {
      // Get the PID of the tmux pane's shell process.
      const pidResult = await runCommand(
        "tmux",
        ["display-message", "-p", "-t", session, "#{pane_pid}"],
        { allowedExitCodes: [0, 1], timeoutMs: 800 }
      );
      const panePid = pidResult.stdout.trim();
      if (pidResult.exitCode !== 0 || !panePid) {
        this.logger.debug({ session }, "resolveAgentProcessCwd: no pane_pid");
        return null;
      }

      // Find the agent CLI child process (claude, codex, or opencode).
      const childrenResult = await runCommand("pgrep", ["-P", panePid], {
        allowedExitCodes: [0, 1],
        timeoutMs: 800,
      });
      if (childrenResult.exitCode !== 0 || !childrenResult.stdout.trim()) {
        this.logger.debug(
          { session, panePid },
          "resolveAgentProcessCwd: no children"
        );
        return null;
      }

      const childPids = childrenResult.stdout.trim().split("\n");
      let agentPid: string | null = null;

      for (const pid of childPids) {
        const commResult = await runCommand(
          "ps",
          ["-o", "comm=", "-p", pid.trim()],
          { allowedExitCodes: [0, 1], timeoutMs: 800 }
        );
        const comm = commResult.stdout.trim();
        // Match agent CLI binaries by basename.
        const basename = comm.split("/").pop() ?? "";
        if (
          basename === "claude" ||
          basename === "codex" ||
          basename === "opencode"
        ) {
          agentPid = pid.trim();
          break;
        }
      }

      if (!agentPid) {
        this.logger.debug(
          { session, panePid },
          "resolveAgentProcessCwd: no agent CLI among children"
        );
        return null;
      }

      // Read the process's CWD via lsof (works on macOS and Linux).
      const lsofResult = await runCommand(
        "lsof",
        ["-a", "-p", agentPid, "-d", "cwd", "-Fn"],
        { allowedExitCodes: [0, 1], timeoutMs: 800 }
      );
      if (lsofResult.exitCode !== 0 || !lsofResult.stdout) {
        this.logger.debug(
          { session, agentPid },
          "resolveAgentProcessCwd: lsof failed"
        );
        return null;
      }

      // lsof -Fn outputs lines like "p<pid>" and "n<path>". Extract the path.
      for (const line of lsofResult.stdout.split("\n")) {
        if (line.startsWith("n/")) {
          const cwd = line.slice(1);
          this.logger.debug(
            { session, agentPid, cwd },
            "resolveAgentProcessCwd: resolved"
          );
          return cwd;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  private async startAgentSession(
    agentId: string,
    sessionName: string,
    cwd: string,
    mediaDir: string,
    agentName: string,
    persona: string | null,
    type: AgentType,
    role: AgentRole,
    agentArgs: string[],
    fullAccess: boolean,
    cliSessionId?: string,
    resume?: boolean,
    autoReview?: boolean
  ): Promise<void> {
    if (this.config.agentRuntime === "inert") {
      await mkdir(mediaDir, { recursive: true });
      return;
    }

    await mkdir(mediaDir, { recursive: true });
    const agentCommand = buildAgentCommand(
      this.config,
      type,
      role,
      agentArgs,
      mediaDir,
      sessionName,
      fullAccess,
      cliSessionId,
      resume,
      undefined,
      shouldSuggestSessionRename(agentName, agentId, { persona }),
      !persona && (autoReview ?? false)
    );
    const exitFile = `/tmp/dispatch_${sessionName}.exit`;
    const sessionLogFile = `/tmp/dispatch_setup_${agentId}.log`;
    const wrappedCommand = `bash -c 'exec 2> >(tee "${sessionLogFile}" >&2); ${agentCommand.replaceAll("'", "'\\''")}; echo "EXIT:$?" > ${exitFile}'`;
    await runCommand("tmux", [
      "new-session",
      "-d",
      "-s",
      sessionName,
      "-c",
      cwd,
      wrappedCommand,
    ]);
    await runCommand(
      "tmux",
      ["set-option", "-t", sessionName, "status", "off"],
      {
        allowedExitCodes: [0, 1],
      }
    );
    // Allow DCS passthrough so agent CLIs that wrap escape sequences
    // (e.g. synchronized output) can reach the outer terminal directly.
    await runCommand(
      "tmux",
      ["set-option", "-t", sessionName, "allow-passthrough", "on"],
      {
        allowedExitCodes: [0, 1],
      }
    );
    // Advertise synchronized output support so tmux wraps frame rendering
    // in DEC 2026 sequences, reducing terminal flashing.  Set once per session
    // start (not per WebSocket attach) to avoid unbounded array growth.
    await runCommand(
      "tmux",
      ["set-option", "-as", "terminal-features", "xterm-256color:sync"],
      {
        allowedExitCodes: [0, 1],
      }
    );

    // Detect fast-fail launches (for example, missing codex executable) so status
    // is not left as "running" with no backing tmux session.
    if (!(await this.hasAgentSession(sessionName))) {
      const detail = await this.readSetupLogTail(agentId);
      throw new Error(`tmux session exited immediately after launch${detail}`);
    }
  }

  private async ensureNoExistingSession(sessionName: string): Promise<void> {
    if (this.config.agentRuntime !== "tmux") {
      return;
    }

    if (await this.hasAgentSession(sessionName)) {
      await runCommand("tmux", ["kill-session", "-t", sessionName]);
    }
  }

  private async hasAgentSession(sessionName: string): Promise<boolean> {
    if (this.config.agentRuntime === "inert") {
      return sessionName.trim().length > 0;
    }

    const result = await runCommand(
      "tmux",
      ["has-session", "-t", sessionName],
      {
        allowedExitCodes: [0, 1],
      }
    );
    return result.exitCode === 0;
  }

  private async stopAgentSession(
    sessionName: string,
    force: boolean
  ): Promise<void> {
    if (this.config.agentRuntime === "inert") {
      return;
    }

    if (!force) {
      await runCommand("tmux", ["send-keys", "-t", sessionName, "C-c"]);
      await this.sleep(1200);
    }

    if (await this.hasAgentSession(sessionName)) {
      await runCommand("tmux", ["kill-session", "-t", sessionName]);
    }
  }

  private async runLifecycleHook(
    hookName: "stop",
    agent: AgentRecord
  ): Promise<void> {
    const repoRoot = agent.worktreePath ?? agent.cwd;
    if (!repoRoot) return;

    const hooks = await loadRepoHooks(repoRoot);
    const hook = hooks[hookName];
    if (!hook) return;

    const [command, ...args] = hook.command;
    this.logger.info(
      { agentId: agent.id, hook: hookName, command: hook.command },
      "Running lifecycle hook"
    );

    const result = await runCommand(command, args, {
      cwd: repoRoot,
      env: {
        DISPATCH_AGENT_ID: agent.id,
      },
      timeoutMs: 15_000,
    });

    if (result.exitCode !== 0) {
      this.logger.warn(
        {
          agentId: agent.id,
          hook: hookName,
          exitCode: result.exitCode,
          stderr: result.stderr,
        },
        "Lifecycle hook exited with non-zero code"
      );
    }
  }

  private async seedInitialMedia(
    agentId: string,
    mediaDir: string,
    files: Array<{
      fileName: string;
      originalName?: string;
      buffer: Buffer;
      source: "text" | "user";
      description?: string | null;
    }>
  ): Promise<
    Array<{
      fileName: string;
      displayName: string;
      source: string;
      description: string | null;
    }>
  > {
    const createdAt = new Date();
    const results: Array<{
      fileName: string;
      displayName: string;
      source: string;
      description: string | null;
    }> = [];

    for (const [index, file] of files.entries()) {
      const timestampedFileName = this.timestampMediaFileName(
        file.fileName,
        createdAt,
        index
      );
      await writeFile(path.join(mediaDir, timestampedFileName), file.buffer);
      await this.pool.query(
        `INSERT INTO media (agent_id, file_name, source, size_bytes, description)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          agentId,
          timestampedFileName,
          file.source,
          file.buffer.length,
          file.description ?? null,
        ]
      );
      results.push({
        fileName: timestampedFileName,
        displayName: file.originalName?.trim() || file.fileName,
        source: file.source,
        description: file.description ?? null,
      });
    }

    return results;
  }

  private timestampMediaFileName(
    fileName: string,
    createdAt: Date,
    index: number
  ): string {
    const timestamp = createdAt
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace("T", "-")
      .replace("Z", "");
    const ext = path.extname(fileName);
    const base = path.basename(fileName, ext);
    return `${base}-${timestamp}-${index + 1}${ext}`;
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
    allowRecheck?: boolean;
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

  async getPersonaReviewsByParent(
    parentAgentId: string
  ): Promise<PersonaReviewRecord[]> {
    return personaReviews.getPersonaReviewsByParent(this.pool, parentAgentId);
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

  async getReviewerRecheckContext(
    agentId: string
  ): Promise<ReviewerRecheckContext | null> {
    return personaReviews.getReviewerRecheckContext(this.pool, agentId);
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
        auto_review AS "autoReview",
        cli_session_id AS "cliSessionId",
        (SELECT json_build_object(
           'status', pr.status,
           'message', pr.message,
           'verdict', pr.verdict,
           'summary', pr.summary,
           'filesReviewed', pr.files_reviewed,
           'roundNumber', pr.round_number,
           'allowRecheck', pr.allow_recheck,
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

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Unknown error";
  }

  /**
   * Read the last 20 lines of a setup/session stderr log to include in error messages.
   */
  private async readSetupLogTail(idOrSession: string): Promise<string> {
    const logPath = `/tmp/dispatch_setup_${idOrSession}.log`;
    try {
      const log = await readFile(logPath, "utf-8");
      const tail = log.trim().split("\n").slice(-20).join("\n");
      if (tail) return `\n\nSetup log (last 20 lines):\n${tail}`;
    } catch {
      /* no log file */
    }
    return "";
  }

  private async readExitFile(sessionName: string): Promise<number | null> {
    try {
      const content = await readFile(
        `/tmp/dispatch_${sessionName}.exit`,
        "utf-8"
      );
      const match = content.trim().match(/^EXIT:(\d+)$/);
      return match ? Number(match[1]) : null;
    } catch {
      return null;
    }
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
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

  private async setupWorktree(
    originalCwd: string,
    worktreePath: string
  ): Promise<void> {
    // Copy .env if it exists
    const envSource = path.join(originalCwd, ".env");
    const envDest = path.join(worktreePath, ".env");
    try {
      await copyFile(envSource, envDest);
      this.logger.info({ worktreePath }, "Copied .env into worktree.");
    } catch {
      // .env doesn't exist — that's fine
    }

    // Auto-install dependencies
    const lockfileMap: Array<[string, string, string[]]> = [
      ["pnpm-lock.yaml", "pnpm", ["install"]],
      ["yarn.lock", "yarn", ["install"]],
      ["package-lock.json", "npm", ["install"]],
      ["bun.lockb", "bun", ["install"]],
    ];

    for (const [lockfile, bin, args] of lockfileMap) {
      const lockPath = path.join(worktreePath, lockfile);
      const exists = await stat(lockPath).catch(() => null);
      if (exists) {
        this.logger.info(
          { worktreePath, packageManager: bin },
          "Installing dependencies in worktree."
        );
        try {
          await runCommand(bin, args, {
            cwd: worktreePath,
            timeoutMs: 120_000,
          });
          this.logger.info(
            { worktreePath, packageManager: bin },
            "Dependency install complete."
          );
        } catch (error) {
          this.logger.warn(
            { err: error, worktreePath, packageManager: bin },
            "Dependency install failed."
          );
        }
        break;
      }
    }
  }

  private async hasOutstandingChanges(worktreePath: string): Promise<boolean> {
    const [unmerged, uncommitted] = await Promise.all([
      this.getUnmergedChanges(worktreePath),
      this.getUncommittedChanges(worktreePath),
    ]);
    return unmerged.hasUnmergedCommits || uncommitted.hasUncommittedChanges;
  }

  private async getUnmergedChanges(
    worktreePath: string
  ): Promise<{ hasUnmergedCommits: boolean; changedFiles: string[] }> {
    try {
      // Discover the upstream tracking branch (set at worktree creation time).
      // Falls back to origin/main for older worktrees that don't have one.
      let upstreamRef: string | null = null;
      try {
        const upstream = await runCommand(
          "git",
          ["-C", worktreePath, "rev-parse", "--abbrev-ref", "@{upstream}"],
          { allowedExitCodes: [0, 128], timeoutMs: 5_000 }
        );
        if (upstream.exitCode === 0 && upstream.stdout) {
          upstreamRef = upstream.stdout;
        }
      } catch {
        // No upstream set — will fall back below
      }

      // Determine which remote branch to fetch
      const remoteBranch = upstreamRef?.startsWith("origin/")
        ? upstreamRef.slice("origin/".length)
        : "main";

      await runCommand(
        "git",
        ["-C", worktreePath, "fetch", "origin", remoteBranch, "--quiet"],
        { allowedExitCodes: [0, 1, 128], timeoutMs: 15_000 }
      );

      // Resolve the base ref: prefer upstream, fall back to origin/main → main
      const baseRef =
        (upstreamRef
          ? await this.resolveRef(worktreePath, upstreamRef)
          : null) ??
        (await this.resolveRef(worktreePath, "origin/main")) ??
        (await this.resolveRef(worktreePath, "main"));
      if (!baseRef) {
        return { hasUnmergedCommits: false, changedFiles: [] };
      }

      // Simulate merging this branch into main. If the resulting tree is
      // identical to main's tree, everything on this branch is already in main
      // (handles squash-merges, rebases, and main moving forward with releases).
      const mergeTree = await runCommand(
        "git",
        ["-C", worktreePath, "merge-tree", "--write-tree", baseRef, "HEAD"],
        { allowedExitCodes: [0, 1], timeoutMs: 10_000 }
      );
      // merge-tree outputs the tree hash on the first line (exit 1 = conflicts)
      const resultTree = mergeTree.stdout.trim().split("\n")[0];
      const mainTree = await runCommand(
        "git",
        ["-C", worktreePath, "rev-parse", `${baseRef}^{tree}`],
        { allowedExitCodes: [0], timeoutMs: 5_000 }
      );

      if (resultTree === mainTree.stdout.trim()) {
        return { hasUnmergedCommits: false, changedFiles: [] };
      }

      // Trees differ — find which files the branch would actually change
      const fileDiff = await runCommand(
        "git",
        [
          "-C",
          worktreePath,
          "diff",
          "--name-only",
          mainTree.stdout.trim(),
          resultTree,
        ],
        { allowedExitCodes: [0], timeoutMs: 10_000 }
      );
      const changedFiles = fileDiff.stdout.trim().split("\n").filter(Boolean);

      return { hasUnmergedCommits: changedFiles.length > 0, changedFiles };
    } catch {
      return { hasUnmergedCommits: false, changedFiles: [] };
    }
  }

  private async getUncommittedChanges(
    worktreePath: string
  ): Promise<{ hasUncommittedChanges: boolean; uncommittedFiles: string[] }> {
    try {
      // Detect staged + unstaged modifications and untracked files
      const status = await runCommand(
        "git",
        ["-C", worktreePath, "status", "--porcelain"],
        { allowedExitCodes: [0], timeoutMs: 10_000 }
      );
      const uncommittedFiles = status.stdout.trim().split("\n").filter(Boolean);

      return {
        hasUncommittedChanges: uncommittedFiles.length > 0,
        uncommittedFiles,
      };
    } catch {
      return { hasUncommittedChanges: false, uncommittedFiles: [] };
    }
  }

  private async resolveRef(
    worktreePath: string,
    ref: string
  ): Promise<string | null> {
    const result = await runCommand(
      "git",
      ["-C", worktreePath, "rev-parse", "--verify", "--quiet", ref],
      { allowedExitCodes: [0, 1, 128], timeoutMs: 5_000 }
    );
    return result.exitCode === 0 && result.stdout.trim() ? ref : null;
  }
}
