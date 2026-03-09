import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { stat } from "node:fs/promises";
import path from "node:path";

import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";

import type { AppConfig } from "../config.js";
import { runCommand } from "../lib/run-command.js";

type AgentStatus = "creating" | "running" | "stopping" | "stopped" | "error" | "unknown";
type AgentType = "codex" | "claude";
type AgentLatestEventType = "working" | "blocked" | "waiting_user" | "done" | "idle";

type AgentLatestEvent = {
  type: AgentLatestEventType;
  message: string;
  updatedAt: string;
  metadata: Record<string, unknown> | null;
};

export type AgentRecord = {
  id: string;
  name: string;
  type: AgentType;
  status: AgentStatus;
  cwd: string;
  tmuxSession: string | null;
  simulatorUdid: string | null;
  mediaDir: string | null;
  codexArgs: string[];
  lastError: string | null;
  latestEvent: AgentLatestEvent | null;
  createdAt: string;
  updatedAt: string;
};

type CreateAgentInput = {
  name?: string;
  type?: AgentType;
  cwd: string;
  codexArgs?: string[];
};

type StopAgentInput = {
  force?: boolean;
};

type AgentLatestEventInput = {
  type: AgentLatestEventType;
  message: string;
  metadata?: Record<string, unknown>;
};

export class AgentError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

export class AgentManager {
  private readonly pool: Pool;
  private readonly logger: FastifyBaseLogger;
  private readonly config: AppConfig;

  constructor(pool: Pool, logger: FastifyBaseLogger, config: AppConfig) {
    this.pool = pool;
    this.logger = logger;
    this.config = config;
  }

  async listAgents(): Promise<AgentRecord[]> {
    const result = await this.pool.query(`${this.baseAgentSelectSql()} ORDER BY created_at DESC`);
    return result.rows as AgentRecord[];
  }

  async getAgent(id: string): Promise<AgentRecord | null> {
    const result = await this.pool.query(`${this.baseAgentSelectSql()} WHERE id = $1`, [id]);
    return (result.rows[0] as AgentRecord | undefined) ?? null;
  }

  async createAgent(input: CreateAgentInput): Promise<AgentRecord> {
    const cwd = await this.validateWorkingDirectory(input.cwd);
    const id = this.newAgentId();
    const tmuxSession = this.toSessionName(id);
    const type: AgentType = input.type ?? "codex";
    const codexArgs = input.codexArgs ?? [];
    const name = input.name?.trim() || `agent-${id.slice(-6)}`;
    const mediaDir = path.join(this.config.mediaRoot, id);
    await mkdir(mediaDir, { recursive: true });

    await this.pool.query(
      `
      INSERT INTO agents (id, name, type, status, cwd, tmux_session, media_dir, codex_args, updated_at)
      VALUES ($1, $2, $3, 'creating', $4, $5, $6, $7::jsonb, NOW())
      `,
      [id, name, type, cwd, tmuxSession, mediaDir, JSON.stringify(codexArgs)]
    );

    try {
      await this.ensureNoExistingSession(tmuxSession);
      await this.startTmuxSession(tmuxSession, cwd, mediaDir, codexArgs);
      await this.setAgentStatus(id, "running", null);
      await this.setSystemLatestEvent(id, {
        type: "working",
        message: "Session started."
      });
    } catch (error) {
      const message = this.errorMessage(error);
      await this.setAgentStatus(id, "error", message);
      await this.setSystemLatestEvent(id, {
        type: "blocked",
        message: `Failed to create agent: ${message}`,
        metadata: { source: "system", phase: "create" }
      });
      throw new AgentError(`Failed to create agent: ${message}`, 500);
    }

    return (await this.getAgent(id)) as AgentRecord;
  }

  async startAgent(id: string): Promise<AgentRecord> {
    const agent = await this.getRequiredAgent(id);
    const tmuxSession = agent.tmuxSession ?? this.toSessionName(agent.id);
    const hasSession = await this.tmuxHasSession(tmuxSession);

    if (hasSession) {
      await this.setAgentStatus(id, "running", null, tmuxSession);
      await this.setSystemLatestEvent(id, {
        type: "working",
        message: "Session attached to existing tmux session."
      });
      return (await this.getAgent(id)) as AgentRecord;
    }

    await this.setAgentStatus(id, "creating", null);

    try {
      await this.startTmuxSession(tmuxSession, agent.cwd, agent.mediaDir ?? this.defaultMediaDir(id), agent.codexArgs ?? []);
      await this.setAgentStatus(id, "running", null, tmuxSession);
      await this.setSystemLatestEvent(id, {
        type: "working",
        message: "Session started."
      });
    } catch (error) {
      const message = this.errorMessage(error);
      await this.setAgentStatus(id, "error", message, tmuxSession);
      await this.setSystemLatestEvent(id, {
        type: "blocked",
        message: `Failed to start agent: ${message}`,
        metadata: { source: "system", phase: "start" }
      });
      throw new AgentError(`Failed to start agent: ${message}`, 500);
    }

    return (await this.getAgent(id)) as AgentRecord;
  }

  async getTerminalSession(id: string): Promise<string> {
    const agent = await this.getRequiredAgent(id);
    if (agent.status !== "running") {
      throw new AgentError("Agent is not running.", 409);
    }

    if (!agent.tmuxSession) {
      throw new AgentError("Agent is missing tmux session metadata.", 500);
    }

    const hasSession = await this.tmuxHasSession(agent.tmuxSession);
    if (!hasSession) {
      await this.setAgentStatus(id, "stopped", "Agent tmux session is no longer running.", agent.tmuxSession);
      throw new AgentError("Agent session is not available. Start the agent again.", 409);
    }

    return agent.tmuxSession;
  }

  async stopAgent(id: string, input: StopAgentInput = {}): Promise<AgentRecord> {
    const agent = await this.getRequiredAgent(id);
    const tmuxSession = agent.tmuxSession;
    const force = input.force ?? false;

    if (agent.status === "stopped") {
      return agent;
    }

    await this.setAgentStatus(id, "stopping", null, tmuxSession ?? undefined);

    try {
      if (tmuxSession && (await this.tmuxHasSession(tmuxSession))) {
        if (!force) {
          await runCommand("tmux", ["send-keys", "-t", tmuxSession, "C-c"]);
          await this.sleep(1200);
        }

        if (await this.tmuxHasSession(tmuxSession)) {
          await runCommand("tmux", ["kill-session", "-t", tmuxSession]);
        }
      }

      await this.setAgentStatus(id, "stopped", null, tmuxSession ?? undefined);
      await this.setSystemLatestEvent(id, {
        type: "idle",
        message: "Session stopped."
      });
    } catch (error) {
      const message = this.errorMessage(error);
      await this.setAgentStatus(id, "error", message, tmuxSession ?? undefined);
      await this.setSystemLatestEvent(id, {
        type: "blocked",
        message: `Failed to stop agent: ${message}`,
        metadata: { source: "system", phase: "stop" }
      });
      throw new AgentError(`Failed to stop agent: ${message}`, 500);
    }

    return (await this.getAgent(id)) as AgentRecord;
  }

  async deleteAgent(id: string, force = false): Promise<void> {
    const agent = await this.getRequiredAgent(id);
    const sessionExists = agent.tmuxSession ? await this.tmuxHasSession(agent.tmuxSession) : false;

    // If tmux is already gone, treat the agent as effectively stopped even if status is stale.
    if (agent.status === "running" && sessionExists && !force) {
      throw new AgentError("Agent is running. Stop it first or use force delete.", 409);
    }

    if (agent.status === "running" && !sessionExists) {
      await this.setAgentStatus(id, "stopped", null, agent.tmuxSession ?? undefined);
    }

    if (force && agent.tmuxSession && sessionExists) {
      await runCommand("tmux", ["kill-session", "-t", agent.tmuxSession]);
    }

    await this.pool.query("DELETE FROM agents WHERE id = $1", [id]);
  }

  async upsertLatestEvent(id: string, input: AgentLatestEventInput): Promise<AgentRecord> {
    const message = input.message.trim();
    if (!message) {
      throw new AgentError("Latest event message must be a non-empty string.", 400);
    }

    const result = await this.pool.query(
      `
      UPDATE agents
      SET latest_event_type = $2,
          latest_event_message = $3,
          latest_event_metadata = $4::jsonb,
          latest_event_updated_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
      `,
      [id, input.type, message, JSON.stringify(input.metadata ?? {})]
    );

    if (result.rowCount !== 1) {
      throw new AgentError("Agent not found.", 404);
    }

    return (await this.getAgent(id)) as AgentRecord;
  }

  async reconcileAgents(): Promise<void> {
    const result = await this.pool.query(
      "SELECT id, tmux_session AS \"tmuxSession\" FROM agents WHERE status IN ('running', 'creating', 'unknown')"
    );

    for (const row of result.rows as Array<{ id: string; tmuxSession: string | null }>) {
      const exists = row.tmuxSession ? await this.tmuxHasSession(row.tmuxSession) : false;
      await this.setAgentStatus(row.id, exists ? "running" : "stopped", null, row.tmuxSession ?? undefined);
    }
  }

  private async startTmuxSession(
    sessionName: string,
    cwd: string,
    mediaDir: string,
    codexArgs: string[]
  ): Promise<void> {
    await mkdir(mediaDir, { recursive: true });
    const codexCommand = this.buildCodexCommand(codexArgs, mediaDir, sessionName);
    await runCommand("tmux", ["new-session", "-d", "-s", sessionName, "-c", cwd, codexCommand]);

    // Detect fast-fail launches (for example, missing codex executable) so status
    // is not left as "running" with no backing tmux session.
    if (!(await this.tmuxHasSession(sessionName))) {
      throw new Error("tmux session exited immediately after launch");
    }
  }

  private async ensureNoExistingSession(sessionName: string): Promise<void> {
    if (await this.tmuxHasSession(sessionName)) {
      await runCommand("tmux", ["kill-session", "-t", sessionName]);
    }
  }

  private async tmuxHasSession(sessionName: string): Promise<boolean> {
    const result = await runCommand("tmux", ["has-session", "-t", sessionName], {
      allowedExitCodes: [0, 1]
    });
    return result.exitCode === 0;
  }

  private buildCodexCommand(args: string[], mediaDir: string, sessionName: string): string {
    const agentId = sessionName.replace(/^(dispatch|hostess)_/, "");
    const launchGuidance =
      "Dispatch startup rules: Playwright default is headless unless the user explicitly asks for headed mode. " +
      "If you validate any UI flow (Playwright or iOS Simulator), capture at least one screenshot of that flow; " +
      "for multi-step UI changes, capture key states (before/after or critical transitions). " +
      "Publish every screenshot you capture, including self-initiated testing screenshots, and never leave screenshots local-only. " +
      "Use dispatch-share <image-path> for Playwright and dispatch-share --sim [udid] for iOS Simulator. " +
      "Use dispatch-event <working|blocked|waiting_user|done|idle> \"message\" to keep your latest status visible in Dispatch. " +
      "For SSE/WebSocket pages, never use waitUntil: \"networkidle\"; use \"domcontentloaded\" or \"load\" and explicit UI-ready checks.";

    const envPrefix = [
      `DISPATCH_AGENT_ID=${this.shellEscape(agentId)}`,
      `DISPATCH_MEDIA_DIR=${this.shellEscape(mediaDir)}`,
      // Compatibility alias for common typo to keep screenshot sharing reliable.
      `DISPATCH_MDEIA_DIR=${this.shellEscape(mediaDir)}`,
      `HOSTESS_AGENT_ID=${this.shellEscape(agentId)}`,
      `HOSTESS_MEDIA_DIR=${this.shellEscape(mediaDir)}`,
      `DISPATCH_PORT=${this.shellEscape(String(this.config.port))}`,
      `HOSTESS_PORT=${this.shellEscape(String(this.config.port))}`,
      // Compatibility alias for common typo to keep screenshot sharing reliable.
      `HOSTESS_MDEIA_DIR=${this.shellEscape(mediaDir)}`,
      `PATH=${this.shellEscape(this.config.dispatchBinDir)}:$PATH`
    ].join(" ");

    if (args.length === 0) {
      return `${envPrefix} ${this.shellEscape(this.config.codexBin)} ${this.shellEscape(launchGuidance)}`;
    }

    const escaped = args.map((arg) => this.shellEscape(arg)).join(" ");
    return `${envPrefix} ${this.shellEscape(this.config.codexBin)} ${escaped} ${this.shellEscape(launchGuidance)}`;
  }

  private shellEscape(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
  }

  private async validateWorkingDirectory(cwd: string): Promise<string> {
    if (!path.isAbsolute(cwd)) {
      throw new AgentError("Working directory must be an absolute path.", 400);
    }

    const directory = await stat(cwd).catch(() => null);
    if (!directory || !directory.isDirectory()) {
      throw new AgentError("Working directory does not exist or is not a directory.", 400);
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
      this.logger.warn({ id, status }, "Agent status update skipped because row was missing.");
    }
  }

  private baseAgentSelectSql(): string {
    return `
      SELECT
        id,
        name,
        type,
        status,
        cwd,
        tmux_session AS "tmuxSession",
        simulator_udid AS "simulatorUdid",
        media_dir AS "mediaDir",
        codex_args AS "codexArgs",
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
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM agents
    `;
  }

  private newAgentId(): string {
    return `agt_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  }

  private toSessionName(agentId: string): string {
    return `dispatch_${agentId}`;
  }

  private defaultMediaDir(agentId: string): string {
    return path.join(this.config.mediaRoot, agentId);
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Unknown error";
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async setSystemLatestEvent(id: string, input: AgentLatestEventInput): Promise<void> {
    try {
      await this.upsertLatestEvent(id, {
        ...input,
        metadata: {
          ...(input.metadata ?? {}),
          source: "system"
        }
      });
    } catch (error) {
      this.logger.warn({ err: error, id, eventType: input.type }, "Failed to upsert system latest event.");
    }
  }
}
