import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { stat } from "node:fs/promises";
import path from "node:path";

import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";

import type { AppConfig } from "../config.js";
import { runCommand } from "../lib/run-command.js";

type AgentStatus = "creating" | "running" | "stopping" | "stopped" | "error" | "unknown";

export type AgentRecord = {
  id: string;
  name: string;
  status: AgentStatus;
  cwd: string;
  tmuxSession: string | null;
  simulatorUdid: string | null;
  mediaDir: string | null;
  codexArgs: string[];
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

type CreateAgentInput = {
  name?: string;
  cwd: string;
  codexArgs?: string[];
};

type StopAgentInput = {
  force?: boolean;
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
    const codexArgs = input.codexArgs ?? [];
    const name = input.name?.trim() || `agent-${id.slice(-6)}`;
    const mediaDir = path.join(this.config.mediaRoot, id);
    await mkdir(mediaDir, { recursive: true });

    await this.pool.query(
      `
      INSERT INTO agents (id, name, status, cwd, tmux_session, media_dir, codex_args, updated_at)
      VALUES ($1, $2, 'creating', $3, $4, $5, $6::jsonb, NOW())
      `,
      [id, name, cwd, tmuxSession, mediaDir, JSON.stringify(codexArgs)]
    );

    try {
      await this.ensureNoExistingSession(tmuxSession);
      await this.startTmuxSession(tmuxSession, cwd, mediaDir, codexArgs);
      await this.setAgentStatus(id, "running", null);
    } catch (error) {
      const message = this.errorMessage(error);
      await this.setAgentStatus(id, "error", message);
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
      return (await this.getAgent(id)) as AgentRecord;
    }

    await this.setAgentStatus(id, "creating", null);

    try {
      await this.startTmuxSession(tmuxSession, agent.cwd, agent.mediaDir ?? this.defaultMediaDir(id), agent.codexArgs ?? []);
      await this.setAgentStatus(id, "running", null, tmuxSession);
    } catch (error) {
      const message = this.errorMessage(error);
      await this.setAgentStatus(id, "error", message, tmuxSession);
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
    } catch (error) {
      const message = this.errorMessage(error);
      await this.setAgentStatus(id, "error", message, tmuxSession ?? undefined);
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
      "Dispatch startup instructions: Use dispatch-share for all Playwright or iOS simulator screenshots. " +
      "For Playwright: dispatch-share <image-path>. For iOS Simulator capture: dispatch-share --sim [udid]. " +
      "hostess-share also works as a compatibility alias. " +
      "Prefer this over manual cp so images always appear in the Dispatch Media panel. " +
      "Default Playwright runs to headless mode unless the user explicitly asks for headed mode.";

    const envPrefix = [
      `DISPATCH_AGENT_ID=${this.shellEscape(agentId)}`,
      `DISPATCH_MEDIA_DIR=${this.shellEscape(mediaDir)}`,
      // Compatibility alias for common typo to keep screenshot sharing reliable.
      `DISPATCH_MDEIA_DIR=${this.shellEscape(mediaDir)}`,
      `HOSTESS_AGENT_ID=${this.shellEscape(agentId)}`,
      `HOSTESS_MEDIA_DIR=${this.shellEscape(mediaDir)}`,
      // Compatibility alias for common typo to keep screenshot sharing reliable.
      `HOSTESS_MDEIA_DIR=${this.shellEscape(mediaDir)}`,
      `PATH=${this.shellEscape(this.config.dispatchBinDir)}:$PATH`
    ].join(" ");

    if (args.length === 0) {
      return `${envPrefix} codex ${this.shellEscape(launchGuidance)}`;
    }

    const escaped = args.map((arg) => this.shellEscape(arg)).join(" ");
    return `${envPrefix} codex ${escaped} ${this.shellEscape(launchGuidance)}`;
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
        status,
        cwd,
        tmux_session AS "tmuxSession",
        simulator_udid AS "simulatorUdid",
        media_dir AS "mediaDir",
        codex_args AS "codexArgs",
        last_error AS "lastError",
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
}
