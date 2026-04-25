import { randomUUID } from "node:crypto";
import {
  appendFile,
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
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
  createAgentMcpToken,
  createJobMcpToken,
  createReleaseUpdateToken,
} from "../auth.js";
import {
  assertSafeRefName,
  cleanupGitWorktree,
  createGitWorktree,
  GitWorktreeError,
  worktreePathSlug,
} from "../shared/git/worktree.js";
import { runCommand } from "../shared/lib/run-command.js";
import { loadRepoHooks } from "../shared/mcp/repo-tools.js";
import {
  RECHECK_POLL_TIMEOUT,
  pollCadenceSeconds,
} from "../reviews/poll-cadence.js";
import { harvestTokenUsage } from "./token-harvester.js";

type AgentStatus =
  | "creating"
  | "running"
  | "stopping"
  | "stopped"
  | "archiving"
  | "error"
  | "unknown";
type AgentType = "codex" | "claude" | "opencode" | "terminal";
export type AgentRole = "standard" | "assisted_update";
type AgentLatestEventType =
  | "working"
  | "blocked"
  | "waiting_user"
  | "done"
  | "idle";
type SetupPhase = "worktree" | "env" | "deps" | "session" | null;
type ArchivePhase =
  | "stopping"
  | "worktree-check"
  | "worktree-cleanup"
  | "finalizing"
  | null;
type PinType =
  | "string"
  | "url"
  | "port"
  | "code"
  | "pr"
  | "filename"
  | "markdown";

export type AgentPin = {
  label: string;
  value: string;
  type: PinType;
};

type AgentLatestEvent = {
  type: AgentLatestEventType;
  message: string;
  updatedAt: string;
  metadata: Record<string, unknown> | null;
};

export type AgentGitContext = {
  repoRoot: string;
  branch: string;
  worktreePath: string;
  worktreeName: string;
  isWorktree: boolean;
};

export type AgentRecord = {
  id: string;
  name: string;
  type: AgentType;
  role: AgentRole;
  status: AgentStatus;
  cwd: string;
  worktreePath: string | null;
  worktreeBranch: string | null;
  tmuxSession: string | null;
  simulatorUdid: string | null;
  mediaDir: string | null;
  agentArgs: string[];
  fullAccess: boolean;
  setupPhase: SetupPhase;
  archivePhase: ArchivePhase;
  archiveCleanupMode: WorktreeCleanupMode | null;
  lastError: string | null;
  latestEvent: AgentLatestEvent | null;
  pins: AgentPin[];
  gitContext: AgentGitContext | null;
  gitContextStale: boolean;
  gitContextUpdatedAt: string | null;
  persona: string | null;
  parentAgentId: string | null;
  personaContext: string | null;
  reviewAgentType: AgentType | null;
  review: {
    status: string;
    message: string | null;
    verdict: string | null;
    summary: string | null;
    filesReviewed: string[] | null;
    roundNumber: number;
    allowRecheck: boolean;
    updatedAt: string;
    resolution: {
      summary: string;
      resolutionCommit: string | null;
      submittedAt: string;
      roundNumber: number;
    } | null;
  } | null;
  baseBranch: string | null;
  autoReview: boolean;
  cliSessionId: string | null;
  createdAt: string;
  updatedAt: string;
};

const CLI_BY_AGENT_TYPE: Record<
  Exclude<AgentType, "terminal">,
  keyof Pick<AppConfig, "codexBin" | "claudeBin" | "opencodeBin">
> = {
  codex: "codexBin",
  claude: "claudeBin",
  opencode: "opencodeBin",
};

const CODEX_FULL_ACCESS_ARG = "--dangerously-bypass-approvals-and-sandbox";
const CLAUDE_FULL_ACCESS_ARG = "--dangerously-skip-permissions";
const DISPATCH_API_URL_ENV = "DISPATCH_API_URL";
const DISPATCH_RELEASE_UPDATE_TOKEN_ENV = "DISPATCH_RELEASE_UPDATE_TOKEN";

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
};

type WorktreeCleanupMode = "auto" | "keep" | "force";

export type WorktreeStatus = {
  hasWorktree: boolean;
  hasUnmergedCommits: boolean;
  hasUncommittedChanges: boolean;
  worktreePath: string | null;
  branchName: string | null;
  changedFiles: string[];
  uncommittedFiles: string[];
};

type StopAgentInput = {
  force?: boolean;
};

export type FeedbackInput = {
  severity?: "critical" | "high" | "medium" | "low" | "info";
  filePath?: string;
  lineNumber?: number;
  description: string;
  suggestion?: string;
  mediaRef?: string;
  respondsToFeedbackId?: number;
};

export type PersonaReviewRecord = {
  id: number;
  agentId: string;
  parentAgentId: string;
  persona: string;
  status: string;
  message: string | null;
  verdict: string | null;
  summary: string | null;
  filesReviewed: string[] | null;
  lastReviewedCommit: string | null;
  roundNumber: number;
  allowRecheck: boolean;
  createdAt: string;
  updatedAt: string;
};

export type FeedbackRecord = {
  id: number;
  agentId: string;
  severity: string;
  filePath: string | null;
  lineNumber: number | null;
  description: string;
  suggestion: string | null;
  mediaRef: string | null;
  status: string;
  resolutionReason: string | null;
  resolutionCommit: string | null;
  resolvedAt: string | null;
  roundNumber: number;
  respondsToFeedbackId: number | null;
  createdAt: string;
};

export type PersonaReviewResolutionRecord = {
  id: number;
  reviewId: number;
  roundNumber: number;
  summary: string;
  resolutionCommit: string | null;
  submittedAt: string;
};

export type PersonaReviewResolutionItem = {
  feedbackId: number;
  originalDescription: string;
  originalSeverity: string;
  status: string;
  reason: string | null;
  filePath: string | null;
  lineNumber: number | null;
  suggestion: string | null;
  resolutionCommit: string | null;
  resolvedAt: string | null;
  roundNumber: number;
};

export type AwaitRecheckResult =
  | { status: "pending"; pollAgainInSeconds: number }
  | {
      status: "ready";
      review: PersonaReviewRecord;
      resolution: PersonaReviewResolutionRecord;
      resolutions: PersonaReviewResolutionItem[];
    }
  | { status: "complete" }
  | { status: "cancelled" };

export type AwaitReviewResult =
  | {
      status: "pending";
      pollAgainInSeconds: number;
      review: PersonaReviewRecord;
    }
  | {
      status: "feedback_ready";
      review: PersonaReviewRecord;
      feedbackCount: number;
    }
  | {
      status: "complete";
      review: PersonaReviewRecord;
      feedbackCount: number;
    }
  | {
      status: "cancelled";
      review: PersonaReviewRecord;
    }
  | { status: "no_reviews" };

type AgentLatestEventInput = {
  type: AgentLatestEventType;
  message: string;
  metadata?: Record<string, unknown>;
};

// ── Activity / History / Feedback summary types ──────────────────────

export type ActivitySummaryResult = {
  period: { start: string; end: string };
  projects: Array<{
    directory: string;
    totalWorkingMs: number;
    agentCount: number;
    sessionCount: number;
    outcomes: {
      done: number;
      idle: number;
      blocked: number;
      error: number;
    };
  }>;
  totals: {
    totalWorkingMs: number;
    agentCount: number;
    sessionCount: number;
  };
  topAgents: Array<{
    id: string;
    name: string;
    project: string;
    totalWorkingMs: number;
    latestEventMessage: string;
    latestEventType: string;
  }>;
};

export type AgentHistoryEntry = {
  id: string;
  name: string;
  type: string;
  project: string;
  status: string;
  createdAt: string;
  latestEventType: string | null;
  latestEventMessage: string | null;
  pins: Array<{ label: string; value: string; type: string }>;
  git: {
    branch: string | null;
    worktreeBranch: string | null;
  } | null;
  events?: Array<{
    type: string;
    message: string;
    createdAt: string;
  }>;
  feedback?: Array<{
    id: number;
    persona: string;
    severity: string;
    description: string;
    filePath: string | null;
    suggestion: string | null;
    status: string;
  }>;
  reviews?: Array<{
    persona: string;
    status: string;
    verdict: string | null;
    summary: string | null;
    filesReviewed: string[] | null;
  }>;
};

export type AgentHistoryResult = {
  agents: AgentHistoryEntry[];
  total: number;
  hasMore: boolean;
};

export type FeedbackSummaryResult = {
  period: { start: string; end: string };
  totalFindings: number;
  bySeverity: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
  };
  byStatus: {
    open: number;
    fixed: number;
    ignored: number;
    dismissed: number;
  };
  groups: Array<{
    key: string;
    count: number;
    bySeverity: {
      critical: number;
      high: number;
      medium: number;
      low: number;
      info: number;
    };
    topFindings: Array<{
      description: string;
      count: number;
      severity: string;
      exampleFilePath: string | null;
    }>;
  }>;
  reviewVerdicts: {
    total: number;
    approved: number;
    changesRequested: number;
  };
};

export type AgentTerminalAccess =
  | { mode: "tmux"; sessionName: string }
  | { mode: "inert"; message: string };

export class AgentError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

export type AgentEventListener = (agent: AgentRecord) => void;

/**
 * Input validator for `review_status` pings. Today only `"reviewing"` is
 * valid; extracted as a pure helper so tests can assert the accept/reject
 * behaviour without touching the database.
 */
export function resolveProgressPingStatus(requested: string): "reviewing" {
  if (requested !== "reviewing") {
    throw new AgentError(
      `Invalid review status "${requested}". Must be one of: reviewing`,
      400
    );
  }
  return "reviewing";
}

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
    const tmuxSession = this.toSessionName(id, name);
    const mediaDir = path.join(this.config.mediaRoot, id);
    await mkdir(mediaDir, { recursive: true });

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
      INSERT INTO agents (id, name, type, role, status, cwd, tmux_session, media_dir, codex_args, full_access, setup_phase, persona, parent_agent_id, persona_context, review_agent_type, cli_session_id, auto_review, base_branch, updated_at)
      VALUES ($1, $2, $3, $4, 'creating', $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW())
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
      ]
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
        const agentCommand = this.buildAgentCommand(
          type,
          role,
          agentArgs,
          mediaDir,
          tmuxSession,
          fullAccess,
          cliSessionId ?? undefined,
          false,
          input.jobRunId,
          this.shouldSuggestSessionRename(name, id, {
            persona: input.persona,
            jobRunId: input.jobRunId,
          }),
          !input.persona && !input.jobRunId && (input.autoReview ?? false),
          input.initialPrompt
        );
        const exitFile = `/tmp/dispatch_${tmuxSession}.exit`;

        // Generate a setup script that handles worktree creation, env copy,
        // dep install, and then exec's into the agent CLI — all visible in the terminal.
        const setupScript = this.generateSetupScript({
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
      agent.tmuxSession ?? this.toSessionName(agent.id, agent.name);
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
    const agentIds = sessions.map((s) => this.agentIdFromSessionName(s.name));

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
      const agentId = this.agentIdFromSessionName(session.name);
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
    const agentCommand = this.buildAgentCommand(
      type,
      role,
      agentArgs,
      mediaDir,
      sessionName,
      fullAccess,
      cliSessionId,
      resume,
      undefined,
      this.shouldSuggestSessionRename(agentName, agentId, { persona }),
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

  private buildAgentCommand(
    type: AgentType,
    role: AgentRole,
    args: string[],
    mediaDir: string,
    sessionName: string,
    fullAccess: boolean,
    cliSessionId?: string,
    resume?: boolean,
    jobRunId?: string,
    suggestSessionRename?: boolean,
    autoReview?: boolean,
    initialPrompt?: string
  ): string {
    const agentId = this.agentIdFromSessionName(sessionName);
    // Lean startup guidance shared by both agent types. Full behavioral specs live in
    // AGENTS.md (auto-loaded by Codex) and CLAUDE.md (auto-loaded by Claude Code).
    // Rules are built as an array and numbered on output so the agent sees a scannable
    // list rather than a run-on paragraph.
    const rules: string[] = [];

    if (jobRunId) {
      rules.push(
        `You are running a Dispatch job run (${jobRunId}). Job agents have a dedicated MCP route — use repo tools when relevant.`
      );
      if (suggestSessionRename) {
        rules.push(
          "Name the session. Once the topic of work is clear, call dispatch_rename_session with a short name for that topic, task, or feature. The name is a stable label describing what the run is about, not a live status update."
        );
      }
      rules.push("Report status with dispatch_event to keep the UI current.");
      rules.push("Log task-level progress with job_log.");
      rules.push(
        "Call a job terminal tool when the run is complete, failed, or needs input."
      );
    } else {
      rules.push(
        "No task, no work. If the user hasn't explicitly asked for a change, fix, review, or investigation, ask what they want — don't infer a task from branch/worktree context alone."
      );
      if (suggestSessionRename) {
        rules.push(
          "Name the session. Once the topic of work is clear, call dispatch_rename_session with a short name for that topic, task, or feature — the reason for the session. The name is a stable label describing what the session is about, not a live status update. Rename again if the work shifts substantially to a new topic."
        );
      }
      rules.push(
        "Report status with dispatch_event. Types: working (making progress), blocked (stuck, cannot proceed alone), waiting_user (need input), done (task fully complete), idle (answered a question, no code changes). Emit working at turn start and when shifting phases (e.g. research → coding → testing). Emit a terminal event before your final response. Use blocked only when truly stuck — not for errors you're actively fixing."
      );
      rules.push(
        "Pin key info with dispatch_pin so it surfaces in the sidebar — especially values users may need to copy/paste: URLs, commands, branch names, IDs, tokens, simulator UDIDs. Types: url (dev servers, docs), port (server ports), pr (PR links), filename (key files), code (short snippets, env vars, IDs), string (status, decisions), markdown (short structured summaries). Update or delete stale pins. For longer artifacts, write a file via dispatch_share and pin a reference."
      );
      rules.push(
        "Playwright: default headless. Capture at least one screenshot per UI flow via dispatch_share. Call browser_close when done."
      );
      rules.push(
        "For pull requests, use the create_pr MCP tool — not built-in PR skills or gh CLI."
      );
      if (autoReview) {
        rules.push(
          "Autonomous Review is enabled. Before emitting done: commit and push your branch, open a draft PR via create_pr (don't override baseBranch — it defaults correctly), call list_personas, then launch 1 relevant reviewer via dispatch_launch_persona. Poll dispatch_get_feedback until all reviews complete. Address critical/high feedback before resolving; medium and below can be resolved with a comment. Call dispatch_resolve_feedback for each item. Don't emit done until all reviews are resolved."
        );
      }
    }

    const numbered = rules.map((rule, i) => `${i + 1}. ${rule}`).join("\n");
    const header = jobRunId
      ? "Dispatch job startup rules:"
      : "Dispatch startup rules:";
    const launchGuidance = `[dispatch:${agentId}] ${header}\n${numbered}`;

    const userLocalBin = process.env.HOME
      ? path.join(process.env.HOME, ".local/bin")
      : null;
    const launchPathEntries = [this.config.dispatchBinDir, userLocalBin].filter(
      (entry): entry is string => typeof entry === "string" && entry.length > 0
    );
    const launchPathPrefix = Array.from(new Set(launchPathEntries)).join(":");

    const envPrefixParts = [
      `DISPATCH_AGENT_ID=${this.shellEscape(agentId)}`,
      `DISPATCH_MEDIA_DIR=${this.shellEscape(mediaDir)}`,
      `DISPATCH_PORT=${this.shellEscape(String(this.config.port))}`,
      `DISPATCH_SCHEME=${this.config.tls ? "https" : "http"}`,
      `PATH=${this.shellEscape(launchPathPrefix)}:$PATH`,
      // Pin the Bash tool's cwd to the project root (worktree) after every command.
      // Prevents cwd drift back to the original repo root during long conversations.
      `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1`,
    ];

    if (role === "assisted_update") {
      envPrefixParts.push(
        `${DISPATCH_API_URL_ENV}=${this.shellEscape(
          `${this.config.tls ? "https" : "http"}://127.0.0.1:${this.config.port}`
        )}`,
        `${DISPATCH_RELEASE_UPDATE_TOKEN_ENV}=${this.shellEscape(
          createReleaseUpdateToken(this.config.authToken, agentId)
        )}`
      );
    }

    // Forward the clipboard display to agent sessions so CLI tools can read
    // images pasted via the browser clipboard (xclip needs a DISPLAY).
    if (process.platform === "linux" && process.env.DISPATCH_COPY_DISPLAY) {
      envPrefixParts.push(
        `DISPATCH_COPY_DISPLAY=${this.shellEscape(process.env.DISPATCH_COPY_DISPLAY)}`
      );
    }

    // When TLS is enabled with a CA cert, tell agent CLI tools to trust it
    // so loopback MCP connections don't fail certificate verification.
    // TLS_CA should point at the CA that signed the server cert (e.g. mkcert's rootCA.pem).
    const tlsCaPath = process.env.TLS_CA;
    if (this.config.tls && tlsCaPath) {
      envPrefixParts.push(`NODE_EXTRA_CA_CERTS=${this.shellEscape(tlsCaPath)}`);
    }

    if (type === "opencode" && fullAccess) {
      envPrefixParts.push(
        `OPENCODE_PERMISSION=${this.shellEscape(
          JSON.stringify({
            bash: { "*": "allow" },
            edit: { "*": "allow" },
            read: { "*": "allow" },
            list: { "*": "allow" },
            glob: { "*": "allow" },
            grep: { "*": "allow" },
            task: { "*": "allow" },
            todowrite: { "*": "allow" },
            todoread: { "*": "allow" },
            webfetch: { "*": "allow" },
            websearch: { "*": "allow" },
            codesearch: { "*": "allow" },
            lsp: { "*": "allow" },
            skill: { "*": "allow" },
            external_directory: { "*": "allow" },
          })
        )}`
      );
    }

    const envPrefix = envPrefixParts.join(" ");

    // Terminal agents have no CLI to launch — drop the user into a login shell
    // in the chosen cwd/worktree. No MCP hookups, no session id tracking.
    if (type === "terminal") {
      return `${envPrefix} "\${SHELL:-/bin/bash}" -l`;
    }

    const cliBin = this.config[CLI_BY_AGENT_TYPE[type]];
    const dispatchMcpUrl = this.dispatchMcpUrl(agentId, jobRunId);
    const dispatchMcpToken = jobRunId
      ? createJobMcpToken(this.config.authToken, jobRunId, agentId)
      : createAgentMcpToken(this.config.authToken, agentId);
    const codexDispatchAuthEnv = "DISPATCH_AUTH_TOKEN";
    const { passthroughArgs, appendedSystemPrompt } =
      this.normalizeAgentArgsForType(type, args);

    if (type === "claude") {
      const mcpConfig = this.shellEscape(
        JSON.stringify({
          mcpServers: {
            dispatch: {
              type: "http",
              url: dispatchMcpUrl,
              headers: {
                Authorization: `Bearer ${dispatchMcpToken}`,
              },
            },
          },
        })
      );
      const mcpFlag = `--mcp-config ${mcpConfig}`;
      // Elevate guidance to system prompt so it persists through long conversations
      // and isn't buried as an early user message. CLAUDE.md is also auto-loaded by
      // Claude Code and provides the full behavioral spec.
      const systemFlag = `--append-system-prompt ${this.shellEscape(launchGuidance)}`;
      // Session tracking: --resume continues an existing session, --session-id starts
      // a new one with a known ID for token attribution and future resume.
      const sessionFlag = cliSessionId
        ? resume
          ? `--resume ${this.shellEscape(cliSessionId)}`
          : `--session-id ${this.shellEscape(cliSessionId)}`
        : "";
      const flags = [mcpFlag, systemFlag, sessionFlag]
        .filter(Boolean)
        .join(" ");
      // initialPrompt becomes the first user message (positional arg to Claude Code CLI)
      const allArgs = initialPrompt ? [...args, initialPrompt] : args;
      if (allArgs.length === 0) {
        return `${envPrefix} ${this.shellEscape(cliBin)} ${flags}`;
      }
      const escaped = allArgs.map((arg) => this.shellEscape(arg)).join(" ");
      return `${envPrefix} ${this.shellEscape(cliBin)} ${flags} ${escaped}`;
    }

    if (type === "opencode") {
      const promptParts = [
        launchGuidance,
        appendedSystemPrompt,
        initialPrompt,
      ].filter(Boolean);
      const startupPrompt = promptParts.join("\n\n");
      const promptFlag = `--prompt ${this.shellEscape(startupPrompt)}`;
      const sessionFlag =
        resume && cliSessionId
          ? `--session ${this.shellEscape(cliSessionId)}`
          : "";
      const flagParts = [promptFlag, sessionFlag].filter(Boolean).join(" ");
      if (passthroughArgs.length === 0) {
        return `${envPrefix} ${this.shellEscape(cliBin)} ${flagParts}`;
      }
      const escaped = passthroughArgs
        .map((arg) => this.shellEscape(arg))
        .join(" ");
      return `${envPrefix} ${this.shellEscape(cliBin)} ${escaped} ${flagParts}`;
    }

    // Codex: positional arg — AGENTS.md is auto-loaded by Codex CLI and provides authority.
    const codexMcpFlags = [
      "-c",
      this.shellEscape(
        `mcp_servers.dispatch.url=${JSON.stringify(dispatchMcpUrl)}`
      ),
      "-c",
      this.shellEscape(
        `mcp_servers.dispatch.bearer_token_env_var=${JSON.stringify(codexDispatchAuthEnv)}`
      ),
    ].join(" ");
    const codexEnvPrefix = `${envPrefix} ${codexDispatchAuthEnv}=${this.shellEscape(dispatchMcpToken)}`;
    // Codex resume: `codex resume <sessionId>` with MCP flags
    if (resume && cliSessionId) {
      return `${codexEnvPrefix} ${this.shellEscape(cliBin)} resume ${this.shellEscape(cliSessionId)} ${codexMcpFlags}`;
    }
    const codexPromptParts = [
      launchGuidance,
      appendedSystemPrompt,
      initialPrompt,
    ].filter(Boolean);
    const startupPrompt = codexPromptParts.join("\n\n");
    if (passthroughArgs.length === 0) {
      return `${codexEnvPrefix} ${this.shellEscape(cliBin)} ${codexMcpFlags} ${this.shellEscape(startupPrompt)}`;
    }
    const escaped = passthroughArgs
      .map((arg) => this.shellEscape(arg))
      .join(" ");
    return `${codexEnvPrefix} ${this.shellEscape(cliBin)} ${codexMcpFlags} ${escaped} ${this.shellEscape(startupPrompt)}`;
  }

  private dispatchMcpUrl(agentId: string, jobRunId?: string): string {
    const path = jobRunId
      ? `/api/mcp/jobs/${jobRunId}/${agentId}`
      : `/api/mcp/${agentId}`;
    return `${this.config.tls ? "https" : "http"}://127.0.0.1:${this.config.port}${path}`;
  }

  private shellEscape(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
  }

  private normalizeAgentArgsForType(
    type: AgentType,
    args: string[]
  ): { passthroughArgs: string[]; appendedSystemPrompt: string | null } {
    if (type === "claude") {
      return { passthroughArgs: args, appendedSystemPrompt: null };
    }

    const passthroughArgs: string[] = [];
    let appendedSystemPrompt: string | null = null;

    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (
        arg === "--append-system-prompt" &&
        typeof args[index + 1] === "string"
      ) {
        appendedSystemPrompt = args[index + 1] ?? null;
        index += 1;
        continue;
      }
      passthroughArgs.push(arg);
    }

    return { passthroughArgs, appendedSystemPrompt };
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
    const result = await this.pool.query<PersonaReviewRecord>(
      `INSERT INTO persona_reviews (agent_id, parent_agent_id, persona, last_reviewed_commit, allow_recheck)
       VALUES ($1, $2, $3, $4, COALESCE($5, false))
       RETURNING id, agent_id AS "agentId", parent_agent_id AS "parentAgentId",
                 persona, status, message, verdict, summary,
                 files_reviewed AS "filesReviewed",
                 last_reviewed_commit AS "lastReviewedCommit",
                 round_number AS "roundNumber",
                 allow_recheck AS "allowRecheck",
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [
        input.agentId,
        input.parentAgentId,
        input.persona,
        input.lastReviewedCommit ?? null,
        input.allowRecheck ?? null,
      ]
    );
    return result.rows[0]!;
  }

  async updatePersonaReviewStatus(
    agentId: string,
    input: { status: string; message?: string }
  ): Promise<PersonaReviewRecord> {
    // review_status is a progress-ping channel only. It must not transition
    // the review *out of* a non-working state — in particular, it must not
    // clobber `awaiting_recheck` (reviewer is doing round 2) back to
    // `reviewing` (that tricks completePersonaReview into thinking the next
    // close is round 1 again). Terminal states are also off-limits. Compute
    // the effective next status in code — easier to unit-test and lets us
    // surface a specific error for the terminal cases.
    const nextStatus = resolveProgressPingStatus(input.status);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const currentResult = await client.query<{ status: string }>(
        `SELECT status FROM persona_reviews WHERE agent_id = $1 FOR UPDATE`,
        [agentId]
      );
      const current = currentResult.rows[0];
      if (!current) {
        throw new AgentError("No persona review found for agent.", 404);
      }
      if (current.status === "complete" || current.status === "cancelled") {
        throw new AgentError(
          `Cannot ping review_status on a ${current.status} review. Progress pings are only accepted while the review is active.`,
          409
        );
      }

      // awaiting_recheck is "active" from the reviewer's perspective — they
      // are doing round 2 — so accept the ping but preserve the status label.
      const statusToPersist =
        current.status === "awaiting_recheck" ? current.status : nextStatus;

      const result = await client.query<PersonaReviewRecord>(
        `UPDATE persona_reviews
         SET status = $2, message = $3, updated_at = NOW()
         WHERE agent_id = $1
         RETURNING id, agent_id AS "agentId", parent_agent_id AS "parentAgentId",
                   persona, status, message, verdict, summary,
                   files_reviewed AS "filesReviewed",
                   last_reviewed_commit AS "lastReviewedCommit",
                   round_number AS "roundNumber",
                   allow_recheck AS "allowRecheck",
                   created_at AS "createdAt", updated_at AS "updatedAt"`,
        [agentId, statusToPersist, input.message ?? null]
      );
      await client.query("COMMIT");
      return result.rows[0]!;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
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
    const VALID_VERDICTS = ["approve", "request_changes"];
    if (!VALID_VERDICTS.includes(input.verdict)) {
      throw new AgentError(
        `verdict must be one of: ${VALID_VERDICTS.join(", ")}`,
        400
      );
    }
    if (input.summary.length > 10_000) {
      throw new AgentError("summary exceeds 10,000 character limit.", 400);
    }
    if (input.message && input.message.length > 5_000) {
      throw new AgentError("message exceeds 5,000 character limit.", 400);
    }
    if (input.filesReviewed) {
      if (input.filesReviewed.length > 500) {
        throw new AgentError("filesReviewed exceeds 500 item limit.", 400);
      }
      for (const filePath of input.filesReviewed) {
        if (filePath.length > 500) {
          throw new AgentError(
            "Individual file path in filesReviewed exceeds 500 character limit.",
            400
          );
        }
      }
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const currentResult = await client.query<PersonaReviewRecord>(
        `SELECT id, agent_id AS "agentId", parent_agent_id AS "parentAgentId",
                persona, status, message, verdict, summary,
                files_reviewed AS "filesReviewed",
                last_reviewed_commit AS "lastReviewedCommit",
                round_number AS "roundNumber",
                allow_recheck AS "allowRecheck",
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM persona_reviews
         WHERE agent_id = $1
         FOR UPDATE`,
        [agentId]
      );
      const current = currentResult.rows[0];
      if (!current) {
        throw new AgentError("No persona review found for agent.", 404);
      }

      let nextRoundNumber = current.roundNumber;
      if (current.status === "reviewing") {
        // Normally 'reviewing' means round 1. But defense-in-depth:
        // if there's already a submitted resolution for this review,
        // the next close belongs to the round after the resolution, no
        // matter how we ended up back in 'reviewing'. This guards
        // against any future path that could downgrade the status
        // field while a round-trip is in flight.
        const priorResolution = await client.query<{ roundNumber: number }>(
          `SELECT round_number AS "roundNumber"
           FROM persona_review_resolutions
           WHERE review_id = $1
           ORDER BY round_number DESC
           LIMIT 1`,
          [current.id]
        );
        const resolvedRound = priorResolution.rows[0]?.roundNumber ?? 0;
        nextRoundNumber = resolvedRound > 0 ? resolvedRound + 1 : 1;
        if (nextRoundNumber > 2) {
          throw new AgentError(
            "Round 2 already complete. This review only supports a single round-trip.",
            409
          );
        }
      } else if (current.status === "awaiting_recheck") {
        if (current.roundNumber >= 2) {
          throw new AgentError(
            "Round 2 already complete. This review only supports a single round-trip.",
            409
          );
        }
        nextRoundNumber = current.roundNumber + 1;
      } else if (current.status === "complete" && current.roundNumber >= 2) {
        throw new AgentError(
          "Round 2 already complete. This review only supports a single round-trip.",
          409
        );
      } else {
        throw new AgentError(
          `Review can only be completed from 'reviewing' or 'awaiting_recheck' (current: ${current.status}).`,
          409
        );
      }

      const result = await client.query<PersonaReviewRecord>(
        `UPDATE persona_reviews
         SET status = 'complete', verdict = $2, summary = $3,
             files_reviewed = $4::jsonb, message = $5,
             last_reviewed_commit = COALESCE($6, last_reviewed_commit),
             round_number = $7,
             updated_at = NOW()
         WHERE agent_id = $1
         RETURNING id, agent_id AS "agentId", parent_agent_id AS "parentAgentId",
                   persona, status, message, verdict, summary,
                   files_reviewed AS "filesReviewed",
                   last_reviewed_commit AS "lastReviewedCommit",
                   round_number AS "roundNumber",
                   allow_recheck AS "allowRecheck",
                   created_at AS "createdAt", updated_at AS "updatedAt"`,
        [
          agentId,
          input.verdict,
          input.summary,
          JSON.stringify(input.filesReviewed ?? []),
          input.message ?? null,
          input.lastReviewedCommit ?? null,
          nextRoundNumber,
        ]
      );

      await client.query("COMMIT");
      return result.rows[0]!;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async getPersonaReview(agentId: string): Promise<PersonaReviewRecord | null> {
    const result = await this.pool.query<PersonaReviewRecord>(
      `SELECT id, agent_id AS "agentId", parent_agent_id AS "parentAgentId",
              persona, status, message, verdict, summary,
              files_reviewed AS "filesReviewed",
              last_reviewed_commit AS "lastReviewedCommit",
              round_number AS "roundNumber",
              allow_recheck AS "allowRecheck",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM persona_reviews WHERE agent_id = $1`,
      [agentId]
    );
    return result.rows[0] ?? null;
  }

  async getPersonaReviewsByParent(
    parentAgentId: string
  ): Promise<PersonaReviewRecord[]> {
    const result = await this.pool.query<PersonaReviewRecord>(
      `SELECT id, agent_id AS "agentId", parent_agent_id AS "parentAgentId",
              persona, status, message, verdict, summary,
              files_reviewed AS "filesReviewed",
              last_reviewed_commit AS "lastReviewedCommit",
              round_number AS "roundNumber",
              allow_recheck AS "allowRecheck",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM persona_reviews WHERE parent_agent_id = $1
       ORDER BY created_at`,
      [parentAgentId]
    );
    return result.rows;
  }

  async listRecentPersonaReviews(
    sinceDays: number
  ): Promise<PersonaReviewRecord[]> {
    const result = await this.pool.query<PersonaReviewRecord>(
      `SELECT id, agent_id AS "agentId", parent_agent_id AS "parentAgentId",
              persona, status, message, verdict, summary,
              files_reviewed AS "filesReviewed",
              last_reviewed_commit AS "lastReviewedCommit",
              round_number AS "roundNumber",
              allow_recheck AS "allowRecheck",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM persona_reviews
       WHERE created_at >= NOW() - make_interval(days => $1)
       ORDER BY created_at`,
      [sinceDays]
    );
    return result.rows;
  }

  async listRecentFeedback(
    sinceDays: number
  ): Promise<Array<FeedbackRecord & { persona: string }>> {
    const result = await this.pool.query<FeedbackRecord & { persona: string }>(
      `SELECT f.id, f.agent_id AS "agentId", a.persona, f.severity, f.file_path AS "filePath",
              f.line_number AS "lineNumber", f.description, f.suggestion,
              f.media_ref AS "mediaRef", f.status,
              f.resolution_reason AS "resolutionReason",
              f.resolution_commit AS "resolutionCommit",
              f.resolved_at AS "resolvedAt",
              f.round_number AS "roundNumber",
              f.responds_to_feedback_id AS "respondsToFeedbackId",
              f.created_at AS "createdAt"
       FROM agent_feedback f
       JOIN agents a ON a.id = f.agent_id
       WHERE f.created_at >= NOW() - make_interval(days => $1)
       ORDER BY a.persona, f.created_at ASC`,
      [sinceDays]
    );
    return result.rows;
  }

  // --- Activity / History / Feedback Summaries ---

  async getActivitySummary(params: {
    start: Date;
    end: Date;
    project?: string;
  }): Promise<ActivitySummaryResult> {
    const rangeStart = params.start;
    const rangeEnd = params.end;

    // Build optional project filter for working-time CTE
    const wtProjectFilter = params.project ? "AND project_dir = $3" : "";
    const wtParams: unknown[] = [rangeStart, rangeEnd];
    if (params.project) wtParams.push(params.project);

    // Build conditions for agents table queries
    const agentConditions = [
      "parent_agent_id IS NULL",
      "created_at >= $1",
      "created_at <= $2",
    ];
    const agentParams: unknown[] = [rangeStart, rangeEnd];
    if (params.project) {
      agentParams.push(params.project);
      agentConditions.push(
        `COALESCE(git_context->>'repoRoot', cwd) = $${agentParams.length}`
      );
    }
    const agentWhere = `WHERE ${agentConditions.join(" AND ")}`;

    // Run all three queries in parallel
    const [workingTimeResult, sessionResult, agentMetaResult] =
      await Promise.all([
        // Query 1: Working time per agent per project via SQL window functions
        this.pool.query<{
          agentId: string;
          projectDir: string;
          totalWorkingMs: string;
        }>(
          `WITH boundary AS (
          SELECT DISTINCT ON (ae.agent_id)
            ae.agent_id, ae.event_type,
            $1::timestamptz AS effective_at,
            COALESCE(ae.project_dir, a.cwd) AS project_dir
          FROM agent_events ae
          JOIN agents a ON a.id = ae.agent_id
            AND a.parent_agent_id IS NULL
          WHERE ae.created_at < $1
          ORDER BY ae.agent_id, ae.created_at DESC
        ),
        in_range AS (
          SELECT ae.agent_id, ae.event_type, ae.created_at AS effective_at,
                 COALESCE(ae.project_dir, a.cwd) AS project_dir
          FROM agent_events ae
          JOIN agents a ON a.id = ae.agent_id
            AND a.parent_agent_id IS NULL
          WHERE ae.created_at >= $1 AND ae.created_at <= $2
        ),
        all_events AS (
          SELECT * FROM boundary UNION ALL SELECT * FROM in_range
        ),
        with_next AS (
          SELECT agent_id, event_type, effective_at, project_dir,
                 LEAD(effective_at) OVER (PARTITION BY agent_id ORDER BY effective_at) AS next_at
          FROM all_events
        )
        SELECT
          agent_id AS "agentId",
          project_dir AS "projectDir",
          COALESCE(SUM(
            CASE WHEN event_type = 'working'
            THEN EXTRACT(EPOCH FROM (
              COALESCE(next_at, LEAST($2::timestamptz, NOW())) - effective_at
            )) * 1000
            ELSE 0 END
          ), 0)::bigint AS "totalWorkingMs"
        FROM with_next
        WHERE project_dir IS NOT NULL ${wtProjectFilter}
        GROUP BY agent_id, project_dir`,
          wtParams
        ),

        // Query 2: Session counts and outcomes by project
        this.pool.query<{
          projectDir: string;
          sessionCount: string;
          doneCount: string;
          idleCount: string;
          blockedCount: string;
          errorCount: string;
        }>(
          `SELECT
          COALESCE(git_context->>'repoRoot', cwd) AS "projectDir",
          COUNT(*)::int AS "sessionCount",
          COUNT(*) FILTER (WHERE latest_event_type = 'done')::int AS "doneCount",
          COUNT(*) FILTER (WHERE latest_event_type = 'idle')::int AS "idleCount",
          COUNT(*) FILTER (WHERE latest_event_type = 'blocked')::int AS "blockedCount",
          COUNT(*) FILTER (WHERE status = 'error')::int AS "errorCount"
        FROM agents
        ${agentWhere}
        GROUP BY COALESCE(git_context->>'repoRoot', cwd)`,
          agentParams
        ),

        // Query 3: Agent metadata for top agents list
        this.pool.query<{
          id: string;
          name: string;
          projectDir: string;
          latestEventType: string | null;
          latestEventMessage: string | null;
        }>(
          `SELECT id, name,
          COALESCE(git_context->>'repoRoot', cwd) AS "projectDir",
          latest_event_type AS "latestEventType",
          latest_event_message AS "latestEventMessage"
        FROM agents
        ${agentWhere}`,
          agentParams
        ),
      ]);

    // Aggregate working time by project and by agent
    const projectWorkingTime = new Map<
      string,
      { totalWorkingMs: number; agents: Set<string> }
    >();
    const workingTimeByAgent = new Map<
      string,
      { project: string; totalWorkingMs: number }
    >();

    for (const row of workingTimeResult.rows) {
      const ms = Number(row.totalWorkingMs);

      // Per-project aggregation
      const proj = projectWorkingTime.get(row.projectDir) ?? {
        totalWorkingMs: 0,
        agents: new Set(),
      };
      proj.totalWorkingMs += ms;
      proj.agents.add(row.agentId);
      projectWorkingTime.set(row.projectDir, proj);

      // Per-agent aggregation (for top agents)
      const agent = workingTimeByAgent.get(row.agentId);
      if (agent) {
        agent.totalWorkingMs += ms;
      } else {
        workingTimeByAgent.set(row.agentId, {
          project: row.projectDir,
          totalWorkingMs: ms,
        });
      }
    }

    // Index session data by project
    const sessionsByProject = new Map(
      sessionResult.rows.map((r) => [r.projectDir, r])
    );

    // Merge project-level data
    const allProjectDirs = new Set([
      ...projectWorkingTime.keys(),
      ...sessionsByProject.keys(),
    ]);
    const projects = [...allProjectDirs]
      .map((dir) => {
        const working = projectWorkingTime.get(dir);
        const sessions = sessionsByProject.get(dir);
        return {
          directory: dir,
          totalWorkingMs: working?.totalWorkingMs ?? 0,
          agentCount: working?.agents.size ?? 0,
          sessionCount: Number(sessions?.sessionCount ?? 0),
          outcomes: {
            done: Number(sessions?.doneCount ?? 0),
            idle: Number(sessions?.idleCount ?? 0),
            blocked: Number(sessions?.blockedCount ?? 0),
            error: Number(sessions?.errorCount ?? 0),
          },
        };
      })
      .sort((a, b) => b.totalWorkingMs - a.totalWorkingMs);

    // Build top agents list
    const agentMeta = new Map(agentMetaResult.rows.map((r) => [r.id, r]));
    const topAgents = [...workingTimeByAgent.entries()]
      .sort((a, b) => b[1].totalWorkingMs - a[1].totalWorkingMs)
      .slice(0, 10)
      .map(([id, data]) => {
        const meta = agentMeta.get(id);
        return {
          id,
          name: meta?.name ?? id,
          project: data.project,
          totalWorkingMs: data.totalWorkingMs,
          latestEventMessage: meta?.latestEventMessage ?? "",
          latestEventType: meta?.latestEventType ?? "",
        };
      });

    return {
      period: { start: rangeStart.toISOString(), end: rangeEnd.toISOString() },
      projects,
      totals: {
        totalWorkingMs: projects.reduce((sum, p) => sum + p.totalWorkingMs, 0),
        agentCount: new Set(workingTimeResult.rows.map((r) => r.agentId)).size,
        sessionCount: projects.reduce((sum, p) => sum + p.sessionCount, 0),
      },
      topAgents,
    };
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
    const conditions: string[] = ["created_at >= $1", "created_at <= $2"];
    const queryParams: unknown[] = [params.start, params.end];

    if (!params.includeChildren) {
      conditions.push("parent_agent_id IS NULL");
    }
    if (params.project) {
      queryParams.push(params.project);
      conditions.push(
        `COALESCE(git_context->>'repoRoot', cwd) = $${queryParams.length}`
      );
    }

    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    // Count + paginated list in parallel
    const [countResult, listResult] = await Promise.all([
      this.pool.query<{ count: string }>(
        `SELECT COUNT(*)::int AS count FROM agents ${whereClause}`,
        queryParams
      ),
      this.pool.query<{
        id: string;
        name: string;
        type: string;
        status: string;
        projectDir: string;
        createdAt: string;
        latestEventType: string | null;
        latestEventMessage: string | null;
        pins: AgentPin[];
        gitContext: AgentGitContext | null;
        worktreeBranch: string | null;
        persona: string | null;
        parentAgentId: string | null;
      }>(
        `SELECT id, name, type, status,
          COALESCE(git_context->>'repoRoot', cwd) AS "projectDir",
          created_at AS "createdAt",
          latest_event_type AS "latestEventType",
          latest_event_message AS "latestEventMessage",
          pins,
          git_context AS "gitContext",
          worktree_branch AS "worktreeBranch",
          persona,
          parent_agent_id AS "parentAgentId"
        FROM agents ${whereClause}
        ORDER BY created_at DESC
        LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`,
        [...queryParams, params.limit, params.offset]
      ),
    ]);

    const total = Number(countResult.rows[0]?.count ?? 0);
    const agentIds = listResult.rows.map((a) => a.id);
    // Parent agent IDs for feedback/review lookups (when children are shown standalone,
    // feedback still groups under parent)
    const parentAgentIds = listResult.rows
      .filter((a) => !a.parentAgentId)
      .map((a) => a.id);

    // Fetch related data in parallel
    const [eventsRows, feedbackRows, reviewsRows] = await Promise.all([
      params.includeEvents && agentIds.length > 0
        ? this.pool
            .query<{
              agentId: string;
              type: string;
              message: string;
              createdAt: string;
            }>(
              `SELECT agent_id AS "agentId", event_type AS type, message,
                    created_at AS "createdAt"
             FROM (
               SELECT *, ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY created_at ASC) AS rn
               FROM agent_events
               WHERE agent_id = ANY($1)
             ) ranked
             WHERE rn <= 200
             ORDER BY agent_id, created_at ASC`,
              [agentIds]
            )
            .then((r) => r.rows)
        : [],
      params.includeFeedback && parentAgentIds.length > 0
        ? this.pool
            .query<{
              parentAgentId: string;
              id: number;
              persona: string;
              severity: string;
              description: string;
              filePath: string | null;
              suggestion: string | null;
              status: string;
            }>(
              `SELECT a.parent_agent_id AS "parentAgentId",
                    f.id, a.persona, f.severity, f.description,
                    f.file_path AS "filePath", f.suggestion, f.status
             FROM agent_feedback f
             JOIN agents a ON a.id = f.agent_id
             WHERE a.parent_agent_id = ANY($1)
             ORDER BY f.created_at ASC`,
              [parentAgentIds]
            )
            .then((r) => r.rows)
        : [],
      params.includeReviews && parentAgentIds.length > 0
        ? this.pool
            .query<{
              parentAgentId: string;
              persona: string;
              status: string;
              verdict: string | null;
              summary: string | null;
              filesReviewed: string[] | null;
            }>(
              `SELECT parent_agent_id AS "parentAgentId", persona, status,
                    verdict, summary, files_reviewed AS "filesReviewed"
             FROM persona_reviews
             WHERE parent_agent_id = ANY($1)
             ORDER BY created_at ASC`,
              [parentAgentIds]
            )
            .then((r) => r.rows)
        : [],
    ]);

    // Group related data by agent ID
    const eventsByAgent = new Map<
      string,
      Array<{ type: string; message: string; createdAt: string }>
    >();
    for (const row of eventsRows) {
      const list = eventsByAgent.get(row.agentId) ?? [];
      list.push({
        type: row.type,
        message: row.message,
        createdAt: row.createdAt,
      });
      eventsByAgent.set(row.agentId, list);
    }

    const feedbackByParent = new Map<
      string,
      Array<{
        id: number;
        persona: string;
        severity: string;
        description: string;
        filePath: string | null;
        suggestion: string | null;
        status: string;
      }>
    >();
    for (const row of feedbackRows) {
      const list = feedbackByParent.get(row.parentAgentId) ?? [];
      list.push({
        id: row.id,
        persona: row.persona,
        severity: row.severity,
        description: row.description,
        filePath: row.filePath,
        suggestion: row.suggestion,
        status: row.status,
      });
      feedbackByParent.set(row.parentAgentId, list);
    }

    const reviewsByParent = new Map<
      string,
      Array<{
        persona: string;
        status: string;
        verdict: string | null;
        summary: string | null;
        filesReviewed: string[] | null;
      }>
    >();
    for (const row of reviewsRows) {
      const list = reviewsByParent.get(row.parentAgentId) ?? [];
      list.push({
        persona: row.persona,
        status: row.status,
        verdict: row.verdict,
        summary: row.summary,
        filesReviewed: row.filesReviewed,
      });
      reviewsByParent.set(row.parentAgentId, list);
    }

    const agents: AgentHistoryEntry[] = listResult.rows.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      project: a.projectDir,
      status: a.status,
      createdAt: a.createdAt,
      latestEventType: a.latestEventType,
      latestEventMessage: a.latestEventMessage,
      pins: (a.pins ?? []).map((p) => ({
        label: p.label,
        value: p.value,
        type: p.type,
      })),
      git: a.gitContext
        ? {
            branch: a.gitContext.branch ?? null,
            worktreeBranch: a.worktreeBranch,
          }
        : null,
      ...(params.includeEvents
        ? { events: eventsByAgent.get(a.id) ?? [] }
        : {}),
      ...(params.includeFeedback
        ? { feedback: feedbackByParent.get(a.id) ?? [] }
        : {}),
      ...(params.includeReviews
        ? { reviews: reviewsByParent.get(a.id) ?? [] }
        : {}),
    }));

    return { agents, total, hasMore: params.offset + params.limit < total };
  }

  async getFeedbackSummary(params: {
    start: Date;
    end: Date;
    project?: string;
    groupBy: "persona" | "severity" | "directory";
  }): Promise<FeedbackSummaryResult> {
    const rangeStart = params.start;
    const rangeEnd = params.end;

    const feedbackConditions = ["f.created_at >= $1", "f.created_at <= $2"];
    const feedbackParams: unknown[] = [rangeStart, rangeEnd];
    if (params.project) {
      feedbackParams.push(params.project);
      feedbackConditions.push(
        `COALESCE(pa.git_context->>'repoRoot', pa.cwd, a.cwd) = $${feedbackParams.length}`
      );
    }

    const verdictConditions = ["pr.created_at >= $1", "pr.created_at <= $2"];
    const verdictParams: unknown[] = [rangeStart, rangeEnd];
    if (params.project) {
      verdictParams.push(params.project);
      verdictConditions.push(
        `COALESCE(pa.git_context->>'repoRoot', pa.cwd) = $${verdictParams.length}`
      );
    }

    // Fetch feedback rows and verdict aggregates in parallel
    const [feedbackResult, verdictResult] = await Promise.all([
      this.pool.query<{
        persona: string;
        severity: string;
        description: string;
        filePath: string | null;
        status: string;
        projectRoot: string;
      }>(
        `SELECT a.persona, f.severity, f.description,
                f.file_path AS "filePath", f.status,
                COALESCE(pa.git_context->>'repoRoot', pa.cwd, a.cwd) AS "projectRoot"
         FROM agent_feedback f
         JOIN agents a ON a.id = f.agent_id
         LEFT JOIN agents pa ON pa.id = a.parent_agent_id
         WHERE ${feedbackConditions.join(" AND ")}
         ORDER BY f.created_at ASC`,
        feedbackParams
      ),

      this.pool.query<{
        total: string;
        approved: string;
        changesRequested: string;
      }>(
        `SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE pr.verdict = 'approve')::int AS approved,
          COUNT(*) FILTER (WHERE pr.verdict = 'request_changes')::int AS "changesRequested"
         FROM persona_reviews pr
         JOIN agents pa ON pa.id = pr.parent_agent_id
         WHERE ${verdictConditions.join(" AND ")}`,
        verdictParams
      ),
    ]);

    const rows = feedbackResult.rows;

    // Aggregate severity and status totals
    const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    const byStatus = { open: 0, fixed: 0, ignored: 0, dismissed: 0 };
    for (const row of rows) {
      if (row.severity in bySeverity)
        bySeverity[row.severity as keyof typeof bySeverity]++;
      if (row.status in byStatus)
        byStatus[row.status as keyof typeof byStatus]++;
    }

    // Group by requested dimension
    const groupMap = new Map<string, typeof rows>();
    for (const row of rows) {
      let key: string;
      switch (params.groupBy) {
        case "persona":
          key = row.persona ?? "unknown";
          break;
        case "severity":
          key = row.severity;
          break;
        case "directory": {
          if (!row.filePath) {
            key = "(no file)";
            break;
          }
          const root = row.projectRoot;
          const relative =
            root && row.filePath.startsWith(root)
              ? row.filePath.slice(root.length + 1)
              : row.filePath;
          // Extract directory (drop the filename)
          const lastSlash = relative.lastIndexOf("/");
          key = lastSlash > 0 ? relative.slice(0, lastSlash) : ".";
          break;
        }
      }
      const list = groupMap.get(key) ?? [];
      list.push(row);
      groupMap.set(key, list);
    }

    // Build groups with top findings (exact match deduplication)
    const groups = [...groupMap.entries()]
      .map(([key, items]) => {
        const groupSev = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
        const descCounts = new Map<
          string,
          { count: number; severity: string; filePath: string | null }
        >();

        for (const item of items) {
          if (item.severity in groupSev)
            groupSev[item.severity as keyof typeof groupSev]++;
          const existing = descCounts.get(item.description);
          if (existing) {
            existing.count++;
          } else {
            descCounts.set(item.description, {
              count: 1,
              severity: item.severity,
              filePath: item.filePath,
            });
          }
        }

        const topFindings = [...descCounts.entries()]
          .sort((a, b) => b[1].count - a[1].count)
          .slice(0, 5)
          .map(([description, data]) => ({
            description,
            count: data.count,
            severity: data.severity,
            exampleFilePath: data.filePath,
          }));

        return { key, count: items.length, bySeverity: groupSev, topFindings };
      })
      .sort((a, b) => b.count - a.count);

    const verdict = verdictResult.rows[0];

    return {
      period: { start: rangeStart.toISOString(), end: rangeEnd.toISOString() },
      totalFindings: rows.length,
      bySeverity,
      byStatus,
      groups,
      reviewVerdicts: {
        total: Number(verdict?.total ?? 0),
        approved: Number(verdict?.approved ?? 0),
        changesRequested: Number(verdict?.changesRequested ?? 0),
      },
    };
  }

  // --- Media ---

  async listMedia(agentId: string): Promise<
    Array<{
      fileName: string;
      description: string | null;
      source: string;
      createdAt: string;
    }>
  > {
    const result = await this.pool.query<{
      fileName: string;
      description: string | null;
      source: string;
      createdAt: string;
    }>(
      `SELECT file_name AS "fileName", description, source, created_at AS "createdAt"
       FROM media WHERE agent_id = $1 ORDER BY created_at`,
      [agentId]
    );
    return result.rows;
  }

  // --- Feedback ---

  async submitFeedback(
    agentId: string,
    feedback: FeedbackInput
  ): Promise<FeedbackRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const reviewResult = await client.query<{
        status: string;
        roundNumber: number;
      }>(
        `SELECT status, round_number AS "roundNumber"
         FROM persona_reviews
         WHERE agent_id = $1
         FOR UPDATE`,
        [agentId]
      );
      const review = reviewResult.rows[0];
      const feedbackRoundNumber = review
        ? review.status === "awaiting_recheck"
          ? review.roundNumber + 1
          : review.roundNumber
        : 1;

      if (feedback.respondsToFeedbackId != null) {
        const originalResult = await client.query<{
          agentId: string;
          roundNumber: number;
        }>(
          `SELECT agent_id AS "agentId", round_number AS "roundNumber"
           FROM agent_feedback
           WHERE id = $1`,
          [feedback.respondsToFeedbackId]
        );
        const original = originalResult.rows[0];
        if (!original) {
          throw new AgentError(
            `Feedback ${feedback.respondsToFeedbackId} referenced by respondsToFeedbackId was not found.`,
            400
          );
        }
        if (original.agentId !== agentId) {
          throw new AgentError(
            `respondsToFeedbackId ${feedback.respondsToFeedbackId} belongs to a different review.`,
            400
          );
        }
        if (original.roundNumber !== 1) {
          throw new AgentError(
            `respondsToFeedbackId ${feedback.respondsToFeedbackId} must reference a round-1 finding.`,
            400
          );
        }
      }

      const result = await client.query<FeedbackRecord>(
        `INSERT INTO agent_feedback (
           agent_id,
           severity,
           file_path,
           line_number,
           description,
           suggestion,
           media_ref,
           round_number,
           responds_to_feedback_id
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, agent_id AS "agentId", severity, file_path AS "filePath", line_number AS "lineNumber",
                   description, suggestion, media_ref AS "mediaRef", status,
                   resolution_reason AS "resolutionReason",
                   resolution_commit AS "resolutionCommit",
                   resolved_at AS "resolvedAt",
                   round_number AS "roundNumber",
                   responds_to_feedback_id AS "respondsToFeedbackId",
                   created_at AS "createdAt"`,
        [
          agentId,
          feedback.severity ?? "info",
          feedback.filePath ?? null,
          feedback.lineNumber ?? null,
          feedback.description,
          feedback.suggestion ?? null,
          feedback.mediaRef ?? null,
          feedbackRoundNumber,
          feedback.respondsToFeedbackId ?? null,
        ]
      );

      await client.query("COMMIT");
      return result.rows[0]!;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async listFeedback(agentId: string): Promise<FeedbackRecord[]> {
    const result = await this.pool.query<FeedbackRecord>(
      `SELECT id, agent_id AS "agentId", severity, file_path AS "filePath", line_number AS "lineNumber",
              description, suggestion, media_ref AS "mediaRef", status,
              resolution_reason AS "resolutionReason",
              resolution_commit AS "resolutionCommit",
              resolved_at AS "resolvedAt",
              round_number AS "roundNumber",
              responds_to_feedback_id AS "respondsToFeedbackId",
              created_at AS "createdAt"
       FROM agent_feedback WHERE agent_id = $1 ORDER BY created_at ASC`,
      [agentId]
    );
    return result.rows;
  }

  async listFeedbackByParent(parentAgentId: string): Promise<FeedbackRecord[]> {
    const result = await this.pool.query<FeedbackRecord>(
      `SELECT f.id, f.agent_id AS "agentId", f.severity, f.file_path AS "filePath", f.line_number AS "lineNumber",
              f.description, f.suggestion, f.media_ref AS "mediaRef", f.status,
              f.resolution_reason AS "resolutionReason",
              f.resolution_commit AS "resolutionCommit",
              f.resolved_at AS "resolvedAt",
              f.round_number AS "roundNumber",
              f.responds_to_feedback_id AS "respondsToFeedbackId",
              f.created_at AS "createdAt"
       FROM agent_feedback f
       JOIN agents a ON a.id = f.agent_id
       WHERE a.parent_agent_id = $1
       ORDER BY f.created_at ASC`,
      [parentAgentId]
    );
    return result.rows;
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
    const params: unknown[] = [parentAgentId];
    let whereClause = "WHERE a.parent_agent_id = $1";
    if (persona) {
      params.push(persona);
      whereClause += ` AND a.persona = $${params.length}`;
    }
    params.push(limit);

    const result = await this.pool.query<FeedbackRecord & { persona: string }>(
      `SELECT f.id, f.agent_id AS "agentId", a.persona, f.severity, f.file_path AS "filePath", f.line_number AS "lineNumber",
              f.description, f.suggestion, f.media_ref AS "mediaRef", f.status,
              f.resolution_reason AS "resolutionReason",
              f.resolution_commit AS "resolutionCommit",
              f.resolved_at AS "resolvedAt",
              f.round_number AS "roundNumber",
              f.responds_to_feedback_id AS "respondsToFeedbackId",
              f.created_at AS "createdAt"
       FROM agent_feedback f
       JOIN agents a ON a.id = f.agent_id
       ${whereClause}
       ORDER BY a.persona, f.created_at ASC
       LIMIT $${params.length}`,
      params
    );

    const grouped = new Map<
      string,
      { persona: string; agentId: string; feedback: FeedbackRecord[] }
    >();
    for (const row of result.rows) {
      const key = row.agentId;
      if (!grouped.has(key)) {
        grouped.set(key, {
          persona: row.persona,
          agentId: row.agentId,
          feedback: [],
        });
      }
      const { persona: _p, ...feedbackRecord } = row;
      grouped.get(key)!.feedback.push(feedbackRecord);
    }

    return { personas: Array.from(grouped.values()) };
  }

  async updateFeedbackStatus(
    feedbackId: number,
    agentId: string,
    status: "open" | "dismissed" | "forwarded" | "fixed" | "ignored",
    options: { reason?: string | null; resolutionCommit?: string | null } = {}
  ): Promise<FeedbackRecord | null> {
    const reason = options.reason ?? null;
    if (status === "ignored" && !(reason && reason.trim().length > 0)) {
      throw new AgentError(
        "A reason is required when marking feedback as ignored.",
        400
      );
    }
    const result = await this.pool.query<FeedbackRecord>(
      // resolution_reason / resolution_commit use COALESCE so that a later
      // fixed/ignored call with a null reason (allowed for 'fixed') does not
      // erase the audit-trail captured on the first resolving call.
      // resolved_at is set only on the first transition into fixed/ignored so
      // benign re-calls don't drift the timestamp forward.
      `UPDATE agent_feedback
       SET status = $2,
           resolution_reason = CASE
             WHEN $2 IN ('fixed', 'ignored') THEN COALESCE($4, resolution_reason)
             ELSE resolution_reason
           END,
           resolution_commit = CASE
             WHEN $2 IN ('fixed', 'ignored') THEN COALESCE($5, resolution_commit)
             ELSE resolution_commit
           END,
           resolved_at = CASE
             WHEN $2 IN ('fixed', 'ignored') AND resolved_at IS NULL THEN NOW()
             WHEN $2 NOT IN ('fixed', 'ignored') THEN NULL
             ELSE resolved_at
           END
       WHERE id = $1 AND agent_id = $3
       RETURNING id, agent_id AS "agentId", severity, file_path AS "filePath", line_number AS "lineNumber",
                 description, suggestion, media_ref AS "mediaRef", status,
                 resolution_reason AS "resolutionReason",
                 resolution_commit AS "resolutionCommit",
                 resolved_at AS "resolvedAt",
                 round_number AS "roundNumber",
                 responds_to_feedback_id AS "respondsToFeedbackId",
                 created_at AS "createdAt"`,
      [feedbackId, status, agentId, reason, options.resolutionCommit ?? null]
    );
    return result.rows[0] ?? null;
  }

  async updateFeedbackStatusByParent(
    feedbackId: number,
    parentAgentId: string,
    status: "open" | "dismissed" | "forwarded" | "fixed" | "ignored",
    options: { reason?: string | null; resolutionCommit?: string | null } = {}
  ): Promise<FeedbackRecord | null> {
    const reason = options.reason ?? null;
    if (status === "ignored" && !(reason && reason.trim().length > 0)) {
      throw new AgentError(
        "A reason is required when marking feedback as ignored.",
        400
      );
    }
    const result = await this.pool.query<FeedbackRecord>(
      // See updateFeedbackStatus for the COALESCE / first-transition rationale.
      `UPDATE agent_feedback af
       SET status = $2,
           resolution_reason = CASE
             WHEN $2 IN ('fixed', 'ignored') THEN COALESCE($4, af.resolution_reason)
             ELSE af.resolution_reason
           END,
           resolution_commit = CASE
             WHEN $2 IN ('fixed', 'ignored') THEN COALESCE($5, af.resolution_commit)
             ELSE af.resolution_commit
           END,
           resolved_at = CASE
             WHEN $2 IN ('fixed', 'ignored') AND af.resolved_at IS NULL THEN NOW()
             WHEN $2 NOT IN ('fixed', 'ignored') THEN NULL
             ELSE af.resolved_at
           END
       FROM agents a
       WHERE af.id = $1 AND af.agent_id = a.id AND a.parent_agent_id = $3
       RETURNING af.id, af.agent_id AS "agentId", af.severity, af.file_path AS "filePath",
                 af.line_number AS "lineNumber", af.description, af.suggestion,
                 af.media_ref AS "mediaRef", af.status,
                 af.resolution_reason AS "resolutionReason",
                 af.resolution_commit AS "resolutionCommit",
                 af.resolved_at AS "resolvedAt",
                 af.round_number AS "roundNumber",
                 af.responds_to_feedback_id AS "respondsToFeedbackId",
                 af.created_at AS "createdAt"`,
      [
        feedbackId,
        status,
        parentAgentId,
        reason,
        options.resolutionCommit ?? null,
      ]
    );
    return result.rows[0] ?? null;
  }

  async submitReviewResolution(input: {
    parentAgentId: string;
    personaAgentId: string;
    summary: string;
    resolutionCommit?: string | null;
  }): Promise<{
    review: PersonaReviewRecord;
    resolution: PersonaReviewResolutionRecord;
  }> {
    const summary = input.summary.trim();
    if (summary.length === 0) {
      throw new AgentError("summary is required.", 400);
    }
    if (summary.length > 10_000) {
      throw new AgentError("summary exceeds 10,000 character limit.", 400);
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const reviewResult = await client.query<PersonaReviewRecord>(
        `SELECT id, agent_id AS "agentId", parent_agent_id AS "parentAgentId",
                persona, status, message, verdict, summary,
                files_reviewed AS "filesReviewed",
                last_reviewed_commit AS "lastReviewedCommit",
                round_number AS "roundNumber",
                allow_recheck AS "allowRecheck",
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM persona_reviews
         WHERE agent_id = $1 AND parent_agent_id = $2
         FOR UPDATE`,
        [input.personaAgentId, input.parentAgentId]
      );
      const review = reviewResult.rows[0];
      if (!review) {
        throw new AgentError(
          `No persona review found for agent ${input.personaAgentId} under parent ${input.parentAgentId}.`,
          404
        );
      }
      if (review.status === "awaiting_recheck") {
        throw new AgentError(
          "Review is already awaiting recheck; dispatch_submit_resolution cannot be called again in that state.",
          409
        );
      }
      if (review.status === "complete" && review.roundNumber >= 2) {
        throw new AgentError(
          "Round 2 already complete. This review only supports a single round-trip.",
          409
        );
      }
      if (review.status !== "complete") {
        throw new AgentError(
          `Review must be in status 'complete' to submit a resolution (current: ${review.status}).`,
          409
        );
      }

      const openOrUnresolved = await client.query<{
        id: number;
        status: string;
        resolution_reason: string | null;
      }>(
        `SELECT id, status, resolution_reason
         FROM agent_feedback
         WHERE agent_id = $1
         ORDER BY id ASC`,
        [input.personaAgentId]
      );
      const openIds: number[] = [];
      const ignoredMissingReason: number[] = [];
      for (const row of openOrUnresolved.rows) {
        if (row.status === "open") {
          openIds.push(row.id);
        } else if (
          row.status === "ignored" &&
          !(row.resolution_reason && row.resolution_reason.trim().length > 0)
        ) {
          ignoredMissingReason.push(row.id);
        }
      }
      if (openIds.length > 0) {
        throw new AgentError(
          `Cannot submit resolution — feedback items still open: ${openIds.join(", ")}. Call dispatch_resolve_feedback on each with status 'fixed' or 'ignored' (include a reason for any you ignore), then try again.`,
          409
        );
      }
      if (ignoredMissingReason.length > 0) {
        throw new AgentError(
          `Cannot submit resolution — ignored feedback items missing a reason: ${ignoredMissingReason.join(", ")}. Call dispatch_resolve_feedback again on each with status 'ignored' and a reason explaining why it was not addressed, then try again.`,
          409
        );
      }

      const roundNumber = review.roundNumber;
      const inserted = await client.query<PersonaReviewResolutionRecord>(
        `INSERT INTO persona_review_resolutions
           (review_id, round_number, summary, resolution_commit)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (review_id, round_number) DO UPDATE
           SET summary = EXCLUDED.summary,
               resolution_commit = EXCLUDED.resolution_commit,
               submitted_at = NOW()
         RETURNING id,
                   review_id AS "reviewId",
                   round_number AS "roundNumber",
                   summary,
                   resolution_commit AS "resolutionCommit",
                   submitted_at AS "submittedAt"`,
        [review.id, roundNumber, summary, input.resolutionCommit ?? null]
      );

      const nextStatus = review.allowRecheck ? "awaiting_recheck" : "complete";
      const updatedReviewResult = await client.query<PersonaReviewRecord>(
        `UPDATE persona_reviews
         SET status = $2, updated_at = NOW()
         WHERE id = $1
         RETURNING id, agent_id AS "agentId", parent_agent_id AS "parentAgentId",
                   persona, status, message, verdict, summary,
                   files_reviewed AS "filesReviewed",
                   last_reviewed_commit AS "lastReviewedCommit",
                   round_number AS "roundNumber",
                   allow_recheck AS "allowRecheck",
                   created_at AS "createdAt", updated_at AS "updatedAt"`,
        [review.id, nextStatus]
      );

      await client.query("COMMIT");
      return {
        review: updatedReviewResult.rows[0]!,
        resolution: inserted.rows[0]!,
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async getReviewResolutions(
    reviewId: number
  ): Promise<PersonaReviewResolutionRecord[]> {
    const result = await this.pool.query<PersonaReviewResolutionRecord>(
      `SELECT id, review_id AS "reviewId", round_number AS "roundNumber",
              summary, resolution_commit AS "resolutionCommit",
              submitted_at AS "submittedAt"
       FROM persona_review_resolutions
       WHERE review_id = $1
       ORDER BY round_number ASC, submitted_at ASC`,
      [reviewId]
    );
    return result.rows;
  }

  async cancelReviewRecheck(input: {
    parentAgentId: string;
    personaAgentId: string;
    reason?: string | null;
  }): Promise<PersonaReviewRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const reviewResult = await client.query<PersonaReviewRecord>(
        `SELECT id, agent_id AS "agentId", parent_agent_id AS "parentAgentId",
                persona, status, message, verdict, summary,
                files_reviewed AS "filesReviewed",
                last_reviewed_commit AS "lastReviewedCommit",
                round_number AS "roundNumber",
                allow_recheck AS "allowRecheck",
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM persona_reviews
         WHERE agent_id = $1 AND parent_agent_id = $2
         FOR UPDATE`,
        [input.personaAgentId, input.parentAgentId]
      );
      const review = reviewResult.rows[0];
      if (!review) {
        throw new AgentError(
          `No persona review found for agent ${input.personaAgentId} under parent ${input.parentAgentId}.`,
          404
        );
      }
      if (review.status === "complete" && review.roundNumber >= 2) {
        throw new AgentError(
          "Cannot cancel recheck after round 2 is already complete.",
          409
        );
      }
      if (review.status === "cancelled") {
        await client.query("COMMIT");
        return review;
      }
      if (
        review.status !== "awaiting_recheck" &&
        !(review.status === "complete" && review.allowRecheck)
      ) {
        throw new AgentError(
          `Recheck can only be cancelled while awaiting round 2 or while the reviewer is polling after round 1 (current: ${review.status}).`,
          409
        );
      }

      const updatedResult = await client.query<PersonaReviewRecord>(
        `UPDATE persona_reviews
         SET status = 'cancelled',
             message = COALESCE($2, message),
             updated_at = NOW()
         WHERE id = $1
         RETURNING id, agent_id AS "agentId", parent_agent_id AS "parentAgentId",
                   persona, status, message, verdict, summary,
                   files_reviewed AS "filesReviewed",
                   last_reviewed_commit AS "lastReviewedCommit",
                   round_number AS "roundNumber",
                   allow_recheck AS "allowRecheck",
                   created_at AS "createdAt", updated_at AS "updatedAt"`,
        [review.id, input.reason ?? null]
      );

      await client.query("COMMIT");
      return updatedResult.rows[0]!;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async awaitReviewRecheck(
    personaAgentId: string,
    now = new Date()
  ): Promise<AwaitRecheckResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const reviewResult = await client.query<PersonaReviewRecord>(
        `SELECT id, agent_id AS "agentId", parent_agent_id AS "parentAgentId",
                persona, status, message, verdict, summary,
                files_reviewed AS "filesReviewed",
                last_reviewed_commit AS "lastReviewedCommit",
                round_number AS "roundNumber",
                allow_recheck AS "allowRecheck",
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM persona_reviews
         WHERE agent_id = $1
         FOR UPDATE`,
        [personaAgentId]
      );
      const review = reviewResult.rows[0];
      if (!review) {
        throw new AgentError("No persona review found for agent.", 404);
      }
      if (!review.allowRecheck) {
        throw new AgentError(
          "dispatch_await_recheck is only available for reviews launched with allowRecheck: true.",
          409
        );
      }
      if (review.status === "cancelled") {
        await client.query("COMMIT");
        return { status: "cancelled" };
      }
      if (review.status === "awaiting_recheck") {
        const [resolutionResult, resolutionItemsResult] = await Promise.all([
          client.query<PersonaReviewResolutionRecord>(
            `SELECT id, review_id AS "reviewId", round_number AS "roundNumber",
                    summary, resolution_commit AS "resolutionCommit",
                    submitted_at AS "submittedAt"
             FROM persona_review_resolutions
             WHERE review_id = $1 AND round_number = $2
             ORDER BY submitted_at DESC
             LIMIT 1`,
            [review.id, review.roundNumber]
          ),
          client.query<PersonaReviewResolutionItem>(
            `SELECT id AS "feedbackId",
                    description AS "originalDescription",
                    severity AS "originalSeverity",
                    status,
                    resolution_reason AS reason,
                    file_path AS "filePath",
                    line_number AS "lineNumber",
                    suggestion,
                    resolution_commit AS "resolutionCommit",
                    resolved_at AS "resolvedAt",
                    round_number AS "roundNumber"
             FROM agent_feedback
             WHERE agent_id = $1 AND round_number = $2
             ORDER BY id ASC`,
            [personaAgentId, review.roundNumber]
          ),
        ]);
        const resolution = resolutionResult.rows[0];
        if (!resolution) {
          throw new AgentError(
            `No resolution found for review ${review.id} round ${review.roundNumber}.`,
            409
          );
        }
        await client.query("COMMIT");
        return {
          status: "ready",
          review,
          resolution,
          resolutions: resolutionItemsResult.rows,
        };
      }
      if (review.status !== "complete") {
        throw new AgentError(
          `Review must be complete before awaiting recheck (current: ${review.status}).`,
          409
        );
      }
      if (review.roundNumber >= 2) {
        await client.query("COMMIT");
        return { status: "complete" };
      }

      const pollCadence = pollCadenceSeconds(new Date(review.updatedAt), now);
      if (pollCadence === RECHECK_POLL_TIMEOUT) {
        await client.query(
          `UPDATE persona_reviews
           SET status = 'cancelled',
               message = 'Recheck window expired.',
               updated_at = NOW()
           WHERE id = $1`,
          [review.id]
        );
        await client.query("COMMIT");
        return { status: "cancelled" };
      }

      await client.query("COMMIT");
      return {
        status: "pending",
        pollAgainInSeconds: pollCadence,
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Parent-side polling primitive — symmetric counterpart to
   * awaitReviewRecheck. Returns where one of the caller's child reviews
   * is in its lifecycle so the parent can pause between polls instead of
   * busy-looping or polling dispatch_get_feedback (which fires on the
   * first item that lands and misleads agents into thinking the review
   * is done).
   *
   * Selection:
   *   - If `personaAgentId` is passed, returns that specific review's
   *     state (404 if unknown, 403 if not owned by the caller).
   *   - If `personaAgentId` is null/undefined, picks the highest-
   *     priority review the caller has launched, preferring states that
   *     need parent action: feedback_ready > cancelled > complete >
   *     pending. Ties broken by updatedAt DESC so the most recent signal
   *     wins. Returns `no_reviews` if the caller has never launched a
   *     persona review.
   *
   * Per-review status mapping:
   *   reviewing                                 → pending
   *   awaiting_recheck                          → pending (round 2 in flight)
   *   complete, round 1, allowRecheck=true      → feedback_ready
   *   complete, round 1, allowRecheck=false     → complete (single-pass)
   *   complete, round 2                         → complete (terminal)
   *   cancelled                                 → cancelled
   */
  async awaitReview(
    parentAgentId: string,
    personaAgentId: string | null,
    now = new Date()
  ): Promise<AwaitReviewResult> {
    if (personaAgentId) {
      const reviewResult = await this.pool.query<PersonaReviewRecord>(
        this.personaReviewSelectSql() + ` WHERE agent_id = $1`,
        [personaAgentId]
      );
      const review = reviewResult.rows[0];
      if (!review) {
        throw new AgentError(
          `No persona review found for agent ${personaAgentId}.`,
          404
        );
      }
      if (review.parentAgentId !== parentAgentId) {
        throw new AgentError(
          `Review for ${personaAgentId} was launched by a different parent.`,
          403
        );
      }
      return this.classifyReviewForAwait(review, now);
    }

    const all = await this.pool.query<
      PersonaReviewRecord & { feedbackCount: string }
    >(
      this.personaReviewSelectSql({ withFeedbackCount: true }) +
        ` WHERE parent_agent_id = $1 ORDER BY updated_at DESC`,
      [parentAgentId]
    );
    if (all.rows.length === 0) {
      return { status: "no_reviews" };
    }

    const classified = await Promise.all(
      all.rows.map(async ({ feedbackCount, ...review }) => ({
        review,
        result: await this.classifyReviewForAwait(
          review,
          now,
          Number(feedbackCount ?? "0")
        ),
      }))
    );

    const priority: Record<AwaitReviewResult["status"], number> = {
      feedback_ready: 0,
      cancelled: 1,
      complete: 2,
      pending: 3,
      no_reviews: 4,
    };

    classified.sort(
      (a, b) => priority[a.result.status] - priority[b.result.status]
    );

    return classified[0].result;
  }

  /** Shared SELECT for persona_reviews used by awaitReview. */
  private personaReviewSelectSql(
    options: { withFeedbackCount?: boolean } = {}
  ): string {
    const feedbackCountColumn = options.withFeedbackCount
      ? `,
                   (SELECT COUNT(*) FROM agent_feedback
                    WHERE agent_feedback.agent_id = persona_reviews.agent_id)::text
                     AS "feedbackCount"`
      : "";
    return `SELECT id, agent_id AS "agentId", parent_agent_id AS "parentAgentId",
                   persona, status, message, verdict, summary,
                   files_reviewed AS "filesReviewed",
                   last_reviewed_commit AS "lastReviewedCommit",
                   round_number AS "roundNumber",
                   allow_recheck AS "allowRecheck",
                   created_at AS "createdAt", updated_at AS "updatedAt"${feedbackCountColumn}
            FROM persona_reviews`;
  }

  private async classifyReviewForAwait(
    review: PersonaReviewRecord,
    now: Date,
    prefetchedFeedbackCount?: number
  ): Promise<AwaitReviewResult> {
    if (review.status === "cancelled") {
      return { status: "cancelled", review };
    }

    if (review.status === "reviewing" || review.status === "awaiting_recheck") {
      const cadence = pollCadenceSeconds(new Date(review.updatedAt), now);
      // The parent shouldn't trigger cancellation; if the cadence helper
      // reached its timeout, just keep polling at the longest interval.
      const pollAgainInSeconds =
        cadence === RECHECK_POLL_TIMEOUT ? 600 : cadence;
      return {
        status: "pending",
        pollAgainInSeconds,
        review,
      };
    }

    if (review.status !== "complete") {
      // Defensive: any unexpected status reads as pending so the parent
      // keeps polling and the server stays the source of truth.
      return {
        status: "pending",
        pollAgainInSeconds: 180,
        review,
      };
    }

    let feedbackCount = prefetchedFeedbackCount;
    if (feedbackCount === undefined) {
      const feedbackCountResult = await this.pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM agent_feedback
         WHERE agent_id = $1`,
        [review.agentId]
      );
      feedbackCount = Number(feedbackCountResult.rows[0]?.count ?? "0");
    }

    const isMidRoundTrip = review.allowRecheck && review.roundNumber < 2;
    return {
      status: isMidRoundTrip ? "feedback_ready" : "complete",
      review,
      feedbackCount,
    };
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

  /** Extract agent ID from a session name like "dispatch_agt_abc123_my-task" or "dispatch_dev_agt_abc123_my-task". */
  private agentIdFromSessionName(sessionName: string): string {
    const match = sessionName.match(/(agt_[a-f0-9]{12})/);
    return match?.[1] ?? sessionName.replace(/^[^_]*_/, "");
  }

  private toSessionName(agentId: string, agentName?: string): string {
    const prefix = this.config.sessionPrefix;
    if (!agentName) {
      return `${prefix}_${agentId}`;
    }
    // Sanitize: tmux disallows colons and periods in session names.
    // Collapse whitespace/special chars to hyphens, truncate to keep it readable.
    const slug = agentName
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 30);
    return `${prefix}_${agentId}_${slug}`;
  }

  private shouldSuggestSessionRename(
    agentName: string | null | undefined,
    agentId: string,
    opts: { persona?: string | null; jobRunId?: string }
  ): boolean {
    if (opts.persona) {
      return false;
    }

    const trimmed = agentName?.trim();
    if (opts.jobRunId) {
      const jobNameSuffix = `-${opts.jobRunId.slice(0, 8)}`;
      return (
        !!trimmed &&
        trimmed.startsWith("job-") &&
        trimmed.endsWith(jobNameSuffix)
      );
    }

    return trimmed === `agent-${agentId.slice(-6)}`;
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

  private generateSetupScript(params: {
    agentId: string;
    agentType: AgentType;
    originalCwd: string;
    useWorktree: boolean;
    createNewBranch: boolean;
    worktreeBranchName?: string;
    baseBranch?: string;
    worktreePathOverride?: string;
    agentName: string;
    agentCommand: string;
    exitFile: string;
    jobRunId?: string;
  }): string {
    const {
      agentId,
      agentType,
      originalCwd,
      useWorktree,
      createNewBranch,
      worktreeBranchName,
      worktreePathOverride,
      agentName,
      agentCommand,
      exitFile,
    } = params;

    const serverUrl = `${this.config.tls ? "https" : "http"}://127.0.0.1:${this.config.port}`;
    const authToken = this.config.authToken;

    // Helper function to call back to the server to update setup phase
    const curlPhase = (phase: string) =>
      `curl -sf -X POST "${serverUrl}/api/v1/agents/${agentId}/setup/phase" ` +
      `-H "Content-Type: application/json" ` +
      `-H "Authorization: Bearer ${authToken}" ` +
      `-d '{"phase":"${phase}"}' > /dev/null 2>&1 || true`;

    // Helper to report an unrecoverable setup failure. The bash variable
    // SETUP_ERROR_MSG is interpolated as a JSON string body so the message
    // surfaces in the agent's last_error.
    const curlSetupError = (msgBashVar: string) =>
      `curl -sf -X POST "${serverUrl}/api/v1/agents/${agentId}/setup/error" ` +
      `-H "Content-Type: application/json" ` +
      `-H "Authorization: Bearer ${authToken}" ` +
      `-d "{\\"message\\":\\"\${${msgBashVar}}\\"}" > /dev/null 2>&1 || true`;

    // Helper function for the completion callback
    const curlComplete = (
      cwdVar: string,
      worktreePathVar: string,
      worktreeBranchVar: string
    ) =>
      `curl -sf -X POST "${serverUrl}/api/v1/agents/${agentId}/setup/complete" ` +
      `-H "Content-Type: application/json" ` +
      `-H "Authorization: Bearer ${authToken}" ` +
      `-d "{\\"effectiveCwd\\":\\"${cwdVar}\\",\\"worktreePath\\":${worktreePathVar},\\"worktreeBranch\\":${worktreeBranchVar}}" > /dev/null 2>&1`;

    const lines: string[] = [
      `#!/usr/bin/env bash`,
      `set -euo pipefail`,
      ``,
      `# Dispatch agent setup script for ${agentName}`,
      `# This script runs in tmux so the user can see setup progress in real time.`,
      ``,
      `# Tee stderr to a log file so the server can surface errors when the session`,
      `# exits immediately (e.g. a broken profile script).`,
      `exec 2> >(tee "/tmp/dispatch_setup_${agentId}.log" >&2)`,
      ``,
      `# Source user-defined overrides for agent sessions`,
      `[[ -f ~/.dispatch/env ]] && { set +e; source ~/.dispatch/env; set -euo pipefail; }`,
      ``,
      `BOLD="\\033[1m"`,
      `DIM="\\033[2m"`,
      `GREEN="\\033[32m"`,
      `YELLOW="\\033[33m"`,
      `RED="\\033[31m"`,
      `RESET="\\033[0m"`,
      ``,
      `phase() { printf "\\n\${BOLD}\${GREEN}▸ %s\${RESET}\\n" "$1"; }`,
      `info()  { printf "  \${DIM}%s\${RESET}\\n" "$1"; }`,
      `warn()  { printf "  \${YELLOW}⚠ %s\${RESET}\\n" "$1"; }`,
      `fail()  { printf "  \${RED}✗ %s\${RESET}\\n" "$1"; }`,
      `ok()    { printf "  \${GREEN}✓ %s\${RESET}\\n" "$1"; }`,
      ``,
      `EFFECTIVE_CWD="${this.shellQuote(originalCwd)}"`,
      `WORKTREE_PATH="null"`,
      `WORKTREE_BRANCH="null"`,
      ``,
    ];

    if (useWorktree && worktreeBranchName) {
      // Defense in depth: refs flowing through this function are interpolated
      // into a bash script that runs in tmux, so re-validate them here even
      // though createAgent already normalized them. A failure here is a bug,
      // not user error.
      assertSafeRefName(worktreeBranchName, "worktreeBranchName");
      const effectiveBaseBranch = assertSafeRefName(
        params.baseBranch || "main",
        "baseBranch"
      );

      const phaseLabel = createNewBranch
        ? "Creating git worktree"
        : "Creating managed git worktree";
      const branchLine = createNewBranch
        ? `info "Branch: ${worktreeBranchName}"`
        : `info "Checking out: ${worktreeBranchName}"`;
      lines.push(
        `# --- Worktree creation ---`,
        `phase "${phaseLabel}"`,
        branchLine,
        ``
      );

      // Determine worktree path arg
      const wtPathArg = worktreePathOverride ? `"${worktreePathOverride}"` : "";
      lines.push(
        `REPO_ROOT=$(git -C "${originalCwd}" rev-parse --show-toplevel 2>/dev/null) || {`,
        `  warn "Not a git repository — skipping worktree"`,
        `  ${curlPhase("session")}`,
        `  exec_agent=true`,
        `}`,
        ``,
        `if [ "\${exec_agent:-}" != "true" ]; then`,
        `  info "Fetching origin/${effectiveBaseBranch}..."`,
        `  git -C "$REPO_ROOT" fetch origin "${effectiveBaseBranch}" --quiet 2>/dev/null || true`,
        ``,
        `  BASE_REF="origin/${effectiveBaseBranch}"`,
        `  git -C "$REPO_ROOT" rev-parse --verify "$BASE_REF" > /dev/null 2>&1 || {`,
        `    BASE_REF="${effectiveBaseBranch}"`,
        `  }`,
        ``
      );

      if (worktreePathOverride) {
        lines.push(`  WT_PATH="${worktreePathOverride}"`);
      } else {
        // Default sibling path: <repoRoot>/../<basename>-<slug>. Use the
        // shared slug helper so the bash path matches what worktree.ts
        // computes on the inert path (and includes a hash discriminator
        // when createNewBranch=false to avoid slug collisions).
        const slugSource = createNewBranch
          ? worktreeBranchName
          : effectiveBaseBranch;
        const sluggedBranch = worktreePathSlug(slugSource, { createNewBranch });
        lines.push(
          `  REPO_BASENAME=$(basename "$REPO_ROOT")`,
          `  WT_PATH="$(dirname "$REPO_ROOT")/\${REPO_BASENAME}-${sluggedBranch}"`
        );
      }

      const addCmd = createNewBranch
        ? `git -C "$REPO_ROOT" worktree add -b "${worktreeBranchName}" "$WT_PATH" "$BASE_REF"`
        : `git -C "$REPO_ROOT" worktree add "$WT_PATH" "${effectiveBaseBranch}"`;
      const upstreamLine = createNewBranch
        ? `    git -C "$WT_PATH" branch --set-upstream-to "$BASE_REF" "${worktreeBranchName}" 2>/dev/null || true`
        : null;

      lines.push(
        ``,
        `  WORKTREE_ADD_OUTPUT=$(${addCmd} 2>&1)`,
        `  if [ $? -eq 0 ]; then`,
        `    ok "Worktree created at $WT_PATH"`,
        ...(upstreamLine ? [upstreamLine] : []),
        `    EFFECTIVE_CWD="$WT_PATH"`,
        `    WORKTREE_PATH="\\"$WT_PATH\\""`,
        `    WORKTREE_BRANCH="\\"${worktreeBranchName}\\""`,
        ``,
        `    # --- Copy .env ---`,
        `    ${curlPhase("env")}`,
        `    phase "Copying environment files"`,
        `    if [ -f "${originalCwd}/.env" ]; then`,
        `      cp "${originalCwd}/.env" "$WT_PATH/.env" && ok "Copied .env" || warn "Failed to copy .env"`,
        `    else`,
        `      info "No .env file found — skipping"`,
        `    fi`,
        ``
      );

      if (agentType !== "terminal") {
        lines.push(
          `    # --- Install dependencies ---`,
          `    ${curlPhase("deps")}`,
          `    phase "Installing dependencies"`,
          `    cd "$WT_PATH"`,
          `    if [ -f "pnpm-lock.yaml" ]; then`,
          `      info "Detected pnpm-lock.yaml"`,
          `      pnpm install 2>&1 || warn "pnpm install failed (continuing anyway)"`,
          `      ok "Dependencies installed"`,
          `    elif [ -f "yarn.lock" ]; then`,
          `      info "Detected yarn.lock"`,
          `      yarn install 2>&1 || warn "yarn install failed (continuing anyway)"`,
          `      ok "Dependencies installed"`,
          `    elif [ -f "package-lock.json" ]; then`,
          `      info "Detected package-lock.json"`,
          `      npm install 2>&1 || warn "npm install failed (continuing anyway)"`,
          `      ok "Dependencies installed"`,
          `    elif [ -f "bun.lockb" ]; then`,
          `      info "Detected bun.lockb"`,
          `      bun install 2>&1 || warn "bun install failed (continuing anyway)"`,
          `      ok "Dependencies installed"`,
          `    else`,
          `      info "No lockfile found — skipping dependency install"`,
          `    fi`,
          ``
        );
      }

      lines.push(
        `  else`,
        // The user explicitly asked for an isolated worktree. Don't fall back
        // to running in the primary checkout — surface the failure to the
        // server (so last_error shows up in the UI) and exit. The tmux
        // session-died monitor will reconcile status to stopped.
        `    fail "Worktree creation failed"`,
        `    fail "$WORKTREE_ADD_OUTPUT"`,
        `    SETUP_ERROR_MSG=$(printf "%s" "$WORKTREE_ADD_OUTPUT" | head -c 800 | tr -d "\\n\\r" | sed 's/[\\\\\\"]/\\\\&/g')`,
        `    if [ -z "$SETUP_ERROR_MSG" ]; then SETUP_ERROR_MSG="git worktree add failed"; fi`,
        `    ${curlSetupError("SETUP_ERROR_MSG")}`,
        `    exit 1`,
        `  fi`,
        `fi`,
        ``
      );
    }

    lines.push(
      `# --- Start agent session ---`,
      `${curlPhase("session")}`,
      `phase "Starting agent session"`,
      `info "Type: ${params.agentName}"`,
      ``,
      `# Notify server that setup is complete`,
      `cd "$EFFECTIVE_CWD"`,
      `${curlComplete("$EFFECTIVE_CWD", "$WORKTREE_PATH", "$WORKTREE_BRANCH")}`,
      ``
    );

    // Opencode: write opencode.json with the Dispatch MCP server config.
    if (agentType === "opencode") {
      const dispatchMcpUrl = this.dispatchMcpUrl(agentId, params.jobRunId);
      const dispatchMcpToken = params.jobRunId
        ? createJobMcpToken(authToken, params.jobRunId, agentId)
        : createAgentMcpToken(authToken, agentId);
      const mcpEntry = JSON.stringify({
        type: "remote",
        url: dispatchMcpUrl,
        headers: { Authorization: `Bearer ${dispatchMcpToken}` },
      });
      lines.push(
        `# --- Configure opencode MCP ---`,
        `OPENCODE_CFG="$EFFECTIVE_CWD/opencode.json"`,
        `MCP_ENTRY=${this.shellEscape(mcpEntry)}`,
        `node --input-type=module -e 'import { readFileSync, renameSync, writeFileSync } from "node:fs"; const [configPath, mcpEntryJson] = process.argv.slice(1); const mcpEntry = JSON.parse(mcpEntryJson); let cfg = {}; try { cfg = JSON.parse(readFileSync(configPath, "utf8")); } catch (error) { if (error?.code !== "ENOENT") throw error; } cfg.mcp = { ...(cfg.mcp ?? {}), dispatch: mcpEntry }; const tmpPath = \`\${configPath}.tmp-\${process.pid}\`; writeFileSync(tmpPath, JSON.stringify(cfg, null, 2) + "\\n"); renameSync(tmpPath, configPath);' "$OPENCODE_CFG" "$MCP_ENTRY"`,
        `ok "Configured dispatch MCP in opencode.json"`,
        ``
      );
    }

    lines.push(
      `# exec replaces this shell with the agent CLI — seamless transition`,
      `exec bash -c '${agentCommand.replaceAll("'", "'\\''")}; echo "EXIT:$?" > ${exitFile}'`
    );

    return lines.join("\n") + "\n";
  }

  /** Quote a value for safe embedding in a bash script (single-quote wrapping). */
  private shellQuote(value: string): string {
    return value.replaceAll("'", "'\\''");
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
