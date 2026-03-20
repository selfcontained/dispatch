import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";

import type { AppConfig } from "../config.js";
import { runCommand } from "../lib/run-command.js";

type AgentStatus = "creating" | "running" | "stopping" | "stopped" | "error" | "unknown";
type AgentType = "codex" | "claude" | "opencode";
type AgentLatestEventType = "working" | "blocked" | "waiting_user" | "done" | "idle";

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
  status: AgentStatus;
  cwd: string;
  tmuxSession: string | null;
  simulatorUdid: string | null;
  mediaDir: string | null;
  agentArgs: string[];
  fullAccess: boolean;
  lastError: string | null;
  latestEvent: AgentLatestEvent | null;
  gitContext: AgentGitContext | null;
  gitContextStale: boolean;
  gitContextUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const CLI_BY_AGENT_TYPE: Record<AgentType, keyof Pick<AppConfig, "codexBin" | "claudeBin" | "opencodeBin">> = {
  codex: "codexBin",
  claude: "claudeBin",
  opencode: "opencodeBin"
};

type CreateAgentInput = {
  name?: string;
  type?: AgentType;
  cwd: string;
  agentArgs?: string[];
  fullAccess?: boolean;
};

type StopAgentInput = {
  force?: boolean;
};

type AgentLatestEventInput = {
  type: AgentLatestEventType;
  message: string;
  metadata?: Record<string, unknown>;
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

export class AgentManager {
  private static readonly TMUX_INVENTORY_INTERVAL_MS = 60_000;
  private readonly pool: Pool;
  private readonly logger: FastifyBaseLogger;
  private readonly config: AppConfig;
  private readonly runtimeCwdCache = new Map<string, { value: string; expiresAt: number }>();
  private lastTmuxInventoryAt = 0;

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
    const type: AgentType = input.type ?? "codex";
    const agentArgs = input.agentArgs ?? [];
    const fullAccess = input.fullAccess ?? false;
    const name = input.name?.trim() || `agent-${id.slice(-6)}`;
    const tmuxSession = this.toSessionName(id, name);
    const mediaDir = path.join(this.config.mediaRoot, id);
    await mkdir(mediaDir, { recursive: true });

    await this.pool.query(
      `
      INSERT INTO agents (id, name, type, status, cwd, tmux_session, media_dir, codex_args, full_access, updated_at)
      VALUES ($1, $2, $3, 'creating', $4, $5, $6, $7::jsonb, $8, NOW())
      `,
      [id, name, type, cwd, tmuxSession, mediaDir, JSON.stringify(agentArgs), fullAccess]
    );

    try {
      await this.ensureNoExistingSession(tmuxSession);
      await this.startAgentSession(tmuxSession, cwd, mediaDir, type, agentArgs, fullAccess);
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
    const tmuxSession = agent.tmuxSession ?? this.toSessionName(agent.id, agent.name);
    const hasSession = await this.hasAgentSession(tmuxSession);

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
      await this.startAgentSession(
        tmuxSession,
        agent.cwd,
        agent.mediaDir ?? this.defaultMediaDir(id),
        agent.type,
        agent.agentArgs ?? [],
        agent.fullAccess ?? false
      );
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

  async getTerminalAccess(id: string): Promise<AgentTerminalAccess> {
    const agent = await this.getRequiredAgent(id);
    if (agent.status !== "running") {
      throw new AgentError("Agent is not running.", 409);
    }

    if (!agent.tmuxSession) {
      throw new AgentError("Agent is missing tmux session metadata.", 500);
    }

    if (this.config.agentRuntime === "inert") {
      return {
        mode: "inert",
        message: "Agent is running in inert mode. No tmux session or CLI process is attached in this environment."
      };
    }

    const hasSession = await this.hasAgentSession(agent.tmuxSession);
    if (!hasSession) {
      await this.setAgentStatus(id, "stopped", "Agent tmux session is no longer running.", agent.tmuxSession);
      throw new AgentError("Agent session is not available. Start the agent again.", 409);
    }

    return { mode: "tmux", sessionName: agent.tmuxSession };
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
      if (tmuxSession && (await this.hasAgentSession(tmuxSession))) {
        await this.stopAgentSession(tmuxSession, force);
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
    const sessionExists = agent.tmuxSession ? await this.hasAgentSession(agent.tmuxSession) : false;

    // If tmux is already gone, treat the agent as effectively stopped even if status is stale.
    if (agent.status === "running" && sessionExists && !force) {
      throw new AgentError("Agent is running. Stop it first or use force delete.", 409);
    }

    if (agent.status === "running" && !sessionExists) {
      await this.setAgentStatus(id, "stopped", null, agent.tmuxSession ?? undefined);
    }

    if (agent.tmuxSession && sessionExists) {
      await this.stopAgentSession(agent.tmuxSession, true);
    }

    await this.pool.query("DELETE FROM agents WHERE id = $1", [id]);

    const mediaDir = agent.mediaDir ?? path.join(this.config.mediaRoot, id);
    await rm(mediaDir, { recursive: true, force: true }).catch(() => {});
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
    await this.reconcileAgentStatuses();
    if (this.config.agentRuntime === "tmux") {
      await this.cleanupOrphanedSessions();
    }
  }

  async reconcileAgentStatuses(): Promise<AgentRecord[]> {
    await this.maybeCaptureTmuxInventory();

    const result = await this.pool.query(
      "SELECT id, tmux_session AS \"tmuxSession\", status, updated_at AS \"updatedAt\" FROM agents WHERE status IN ('running', 'stopping', 'creating')"
    );

    const reconciled: AgentRecord[] = [];

    for (const row of result.rows as Array<{ id: string; tmuxSession: string | null; status: string; updatedAt: string }>) {
      const exists = row.tmuxSession ? await this.hasAgentSession(row.tmuxSession) : false;

      if (!exists) {
        const exitInfo = this.config.agentRuntime === "tmux" && row.tmuxSession
          ? await this.readExitFile(row.tmuxSession)
          : null;
        if (this.config.agentRuntime === "tmux" && row.tmuxSession) {
          await this.captureMissingSessionIncident({
            agentId: row.id,
            tmuxSession: row.tmuxSession,
            status: row.status,
            updatedAt: row.updatedAt,
            exitInfo
          });
        }
        if (exitInfo !== null) {
          this.logger.info({ id: row.id, exitCode: exitInfo }, "Agent process exited with code %d", exitInfo);
        }
        await this.setAgentStatus(row.id, "stopped", null, row.tmuxSession ?? undefined);
        await this.setSystemLatestEvent(row.id, {
          type: "idle",
          message: exitInfo !== null ? `Session exited with code ${exitInfo}.` : "Session ended unexpectedly.",
          metadata: { source: "system", ...(exitInfo !== null ? { exitCode: exitInfo } : {}) }
        });
        const agent = await this.getAgent(row.id);
        if (agent) {
          reconciled.push(agent);
        }
      } else if (row.status === "stopping") {
        const STUCK_STOPPING_TIMEOUT_S = 60;
        const stuckSeconds = (Date.now() - new Date(row.updatedAt).getTime()) / 1000;
        if (stuckSeconds > STUCK_STOPPING_TIMEOUT_S) {
          this.logger.warn({ id: row.id, stuckSeconds }, "Agent stuck in stopping state, reverting to running");
          await this.setAgentStatus(row.id, "running", null, row.tmuxSession ?? undefined);
          await this.setSystemLatestEvent(row.id, {
            type: "working",
            message: "Stop timed out — agent reverted to running. Try force stop.",
            metadata: { source: "system" }
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
    const SESSION_PREFIX = "dispatch_agt_";

    let stdout: string | undefined;
    try {
      const result = await runCommand("tmux", ["list-sessions", "-F", "#{session_name}:#{session_created}"], {
        allowedExitCodes: [0, 1]
      });
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
      `SELECT id, status FROM agents WHERE id IN (${placeholders})`,
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
        this.logger.info({ session: session.name, agentId, status }, "Killing orphaned tmux session (agent in terminal state)");
        toKill.push(session.name);
        continue;
      }

      // No DB record — leave it alone. The session may belong to another
      // server instance using the same tmux namespace. Only clean up
      // sessions that *this* database definitively knows about.
      if (!status) {
        this.logger.debug({ session: session.name, agentId }, "Ignoring tmux session with no matching DB record");
      }
    }

    await Promise.all(
      toKill.map((name) => runCommand("tmux", ["kill-session", "-t", name]).catch(() => {}))
    );
  }

  private diagnosticsRoot(): string {
    return path.join(os.homedir(), ".dispatch", "diagnostics");
  }

  private async maybeCaptureTmuxInventory(): Promise<void> {
    const now = Date.now();
    if (now - this.lastTmuxInventoryAt < AgentManager.TMUX_INVENTORY_INTERVAL_MS) {
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
          sessions: await this.captureCommand("tmux", ["list-sessions", "-F", "#{session_name}:#{session_created}"], [0, 1]),
          panes: await this.captureCommand(
            "tmux",
            ["list-panes", "-a", "-F", "#{session_name}:#{window_name}:#{pane_id}:#{pane_pid}:#{pane_current_command}"],
            [0, 1]
          )
        }
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
          sessions: await this.captureCommand("tmux", ["list-sessions", "-F", "#{session_name}:#{session_created}"], [0, 1]),
          panes: await this.captureCommand(
            "tmux",
            ["list-panes", "-a", "-F", "#{session_name}:#{window_name}:#{pane_id}:#{pane_pid}:#{pane_current_command}"],
            [0, 1]
          )
        },
        processes: await this.captureCommand("ps", ["-axo", "pid,ppid,pgid,user,command"], [0]),
        launchctl: await this.captureCommand(
          "launchctl",
          ["print", `gui/${process.getuid?.() ?? -1}/com.dispatch.server`],
          [0, 113]
        )
      };
      const fileName = `${safeTs}-missing-session-${input.agentId}.json`;
      await writeFile(path.join(this.diagnosticsRoot(), fileName), JSON.stringify(payload, null, 2), "utf-8");
    } catch (error) {
      this.logger.warn({ err: error, agentId: input.agentId }, "Failed to capture missing tmux session incident.");
    }
  }

  private async detectTmuxServerPid(): Promise<number | null> {
    const processes = await this.captureCommand("ps", ["-axo", "pid=,comm="], [0]);
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
        stderr: this.errorMessage(error)
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
        this.runtimeCwdCache.set(cacheKey, { value: agentCwd, expiresAt: now + 10_000 });
        return agentCwd;
      }

      // Fall back to tmux pane_current_path (the shell's CWD).
      const result = await runCommand("tmux", ["display-message", "-p", "-t", session, "#{pane_current_path}"], {
        allowedExitCodes: [0, 1],
        timeoutMs: 800
      });
      const cwd = result.stdout.trim();
      if (result.exitCode !== 0 || !cwd) {
        return fallback;
      }
      this.runtimeCwdCache.set(cacheKey, { value: cwd, expiresAt: now + 10_000 });
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
  private async resolveAgentProcessCwd(session: string): Promise<string | null> {
    try {
      // Get the PID of the tmux pane's shell process.
      const pidResult = await runCommand(
        "tmux", ["display-message", "-p", "-t", session, "#{pane_pid}"],
        { allowedExitCodes: [0, 1], timeoutMs: 800 }
      );
      const panePid = pidResult.stdout.trim();
      if (pidResult.exitCode !== 0 || !panePid) {
        this.logger.debug({ session }, "resolveAgentProcessCwd: no pane_pid");
        return null;
      }

      // Find the agent CLI child process (claude, codex, or opencode).
      const childrenResult = await runCommand(
        "pgrep", ["-P", panePid],
        { allowedExitCodes: [0, 1], timeoutMs: 800 }
      );
      if (childrenResult.exitCode !== 0 || !childrenResult.stdout.trim()) {
        this.logger.debug({ session, panePid }, "resolveAgentProcessCwd: no children");
        return null;
      }

      const childPids = childrenResult.stdout.trim().split("\n");
      let agentPid: string | null = null;

      for (const pid of childPids) {
        const commResult = await runCommand(
          "ps", ["-o", "comm=", "-p", pid.trim()],
          { allowedExitCodes: [0, 1], timeoutMs: 800 }
        );
        const comm = commResult.stdout.trim();
        // Match agent CLI binaries by basename.
        const basename = comm.split("/").pop() ?? "";
        if (basename === "claude" || basename === "codex" || basename === "opencode") {
          agentPid = pid.trim();
          break;
        }
      }

      if (!agentPid) {
        this.logger.debug({ session, panePid }, "resolveAgentProcessCwd: no agent CLI among children");
        return null;
      }

      // Read the process's CWD via lsof (works on macOS and Linux).
      const lsofResult = await runCommand(
        "lsof", ["-a", "-p", agentPid, "-d", "cwd", "-Fn"],
        { allowedExitCodes: [0, 1], timeoutMs: 800 }
      );
      if (lsofResult.exitCode !== 0 || !lsofResult.stdout) {
        this.logger.debug({ session, agentPid }, "resolveAgentProcessCwd: lsof failed");
        return null;
      }

      // lsof -Fn outputs lines like "p<pid>" and "n<path>". Extract the path.
      for (const line of lsofResult.stdout.split("\n")) {
        if (line.startsWith("n/")) {
          const cwd = line.slice(1);
          this.logger.debug({ session, agentPid, cwd }, "resolveAgentProcessCwd: resolved");
          return cwd;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  private async startAgentSession(
    sessionName: string,
    cwd: string,
    mediaDir: string,
    type: AgentType,
    agentArgs: string[],
    fullAccess: boolean
  ): Promise<void> {
    if (this.config.agentRuntime === "inert") {
      await mkdir(mediaDir, { recursive: true });
      return;
    }

    await mkdir(mediaDir, { recursive: true });
    const agentCommand = this.buildAgentCommand(type, agentArgs, mediaDir, sessionName, fullAccess);
    const exitFile = `/tmp/dispatch_${sessionName}.exit`;
    const wrappedCommand = `bash -c '${agentCommand.replaceAll("'", "'\\''")}; echo "EXIT:$?" > ${exitFile}'`;
    await runCommand("tmux", ["new-session", "-d", "-s", sessionName, "-c", cwd, wrappedCommand]);
    await runCommand("tmux", ["set-option", "-t", sessionName, "status", "off"], {
      allowedExitCodes: [0, 1]
    });
    // Allow DCS passthrough so agent CLIs that wrap escape sequences
    // (e.g. synchronized output) can reach the outer terminal directly.
    await runCommand("tmux", ["set-option", "-t", sessionName, "allow-passthrough", "on"], {
      allowedExitCodes: [0, 1]
    });

    // Detect fast-fail launches (for example, missing codex executable) so status
    // is not left as "running" with no backing tmux session.
    if (!(await this.hasAgentSession(sessionName))) {
      throw new Error("tmux session exited immediately after launch");
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

    const result = await runCommand("tmux", ["has-session", "-t", sessionName], {
      allowedExitCodes: [0, 1]
    });
    return result.exitCode === 0;
  }

  private async stopAgentSession(sessionName: string, force: boolean): Promise<void> {
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

  private buildAgentCommand(
    type: AgentType,
    args: string[],
    mediaDir: string,
    sessionName: string,
    fullAccess: boolean
  ): string {
    const agentId = this.agentIdFromSessionName(sessionName);
    // Lean startup guidance shared by both agent types. Full behavioral specs live in
    // AGENTS.md (auto-loaded by Codex) and CLAUDE.md (auto-loaded by Claude Code).
    const launchGuidance =
      "Dispatch startup rules: Playwright default is headless unless the user explicitly asks for headed mode. " +
      "Capture at least one screenshot per UI validation flow; publish every screenshot with the dispatch_share MCP tool (filePath + description for Playwright, or source 'simulator' for iOS Simulator) — never leave screenshots local-only. " +
      "Call the dispatch_event MCP tool at the start of each turn (working), when blocked or waiting for input (blocked/waiting_user), and before your final response (done on success, idle for no-op turns). Never send a final response without a terminal status event. " +
      "For SSE/WebSocket pages, never use waitUntil: \"networkidle\"; use \"domcontentloaded\" or \"load\" and explicit UI-ready checks.";

    const userLocalBin = process.env.HOME ? path.join(process.env.HOME, ".local/bin") : null;
    const launchPathEntries = [this.config.dispatchBinDir, userLocalBin].filter(
      (entry): entry is string => typeof entry === "string" && entry.length > 0
    );
    const launchPathPrefix = Array.from(new Set(launchPathEntries)).join(":");

    const envPrefixParts = [
      `DISPATCH_AGENT_ID=${this.shellEscape(agentId)}`,
      `DISPATCH_MEDIA_DIR=${this.shellEscape(mediaDir)}`,
      // Compatibility alias for common typo to keep screenshot sharing reliable.
      `DISPATCH_MDEIA_DIR=${this.shellEscape(mediaDir)}`,
      `HOSTESS_AGENT_ID=${this.shellEscape(agentId)}`,
      `HOSTESS_MEDIA_DIR=${this.shellEscape(mediaDir)}`,
      `DISPATCH_PORT=${this.shellEscape(String(this.config.port))}`,
      `DISPATCH_SCHEME=${this.config.tls ? "https" : "http"}`,
      `HOSTESS_PORT=${this.shellEscape(String(this.config.port))}`,
      // Compatibility alias for common typo to keep screenshot sharing reliable.
      `HOSTESS_MDEIA_DIR=${this.shellEscape(mediaDir)}`,
      `PATH=${this.shellEscape(launchPathPrefix)}:$PATH`
    ];

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
            external_directory: { "*": "allow" }
          })
        )}`
      );
    }

    const envPrefix = envPrefixParts.join(" ");
    const cliBin = this.config[CLI_BY_AGENT_TYPE[type]];
    const dispatchMcpUrl = this.dispatchMcpUrl(agentId);

    if (type === "claude") {
      const mcpConfig = this.shellEscape(JSON.stringify({
        mcpServers: {
          dispatch: {
            type: "http",
            url: dispatchMcpUrl,
            headers: {
              Authorization: `Bearer ${this.config.authToken}`
            }
          }
        }
      }));
      const mcpFlag = `--mcp-config ${mcpConfig}`;
      // Elevate guidance to system prompt so it persists through long conversations
      // and isn't buried as an early user message. CLAUDE.md is also auto-loaded by
      // Claude Code and provides the full behavioral spec.
      const systemFlag = `--append-system-prompt ${this.shellEscape(launchGuidance)}`;
      if (args.length === 0) {
        return `${envPrefix} ${this.shellEscape(cliBin)} ${mcpFlag} ${systemFlag}`;
      }
      const escaped = args.map((arg) => this.shellEscape(arg)).join(" ");
      return `${envPrefix} ${this.shellEscape(cliBin)} ${mcpFlag} ${systemFlag} ${escaped}`;
    }

    if (type === "opencode") {
      const promptFlag = `--prompt ${this.shellEscape(launchGuidance)}`;
      if (args.length === 0) {
        return `${envPrefix} ${this.shellEscape(cliBin)} ${promptFlag}`;
      }
      const escaped = args.map((arg) => this.shellEscape(arg)).join(" ");
      return `${envPrefix} ${this.shellEscape(cliBin)} ${escaped} ${promptFlag}`;
    }

    // Codex: positional arg — AGENTS.md is auto-loaded by Codex CLI and provides authority.
    const codexMcpFlags = [
      "-c",
      this.shellEscape(`mcp_servers.dispatch.url=${JSON.stringify(dispatchMcpUrl)}`),
      "-c",
      this.shellEscape(`mcp_servers.dispatch.headers.Authorization=${JSON.stringify(`Bearer ${this.config.authToken}`)}`)
    ].join(" ");
    if (args.length === 0) {
      return `${envPrefix} ${this.shellEscape(cliBin)} ${codexMcpFlags} ${this.shellEscape(launchGuidance)}`;
    }
    const escaped = args.map((arg) => this.shellEscape(arg)).join(" ");
    return `${envPrefix} ${this.shellEscape(cliBin)} ${codexMcpFlags} ${escaped} ${this.shellEscape(launchGuidance)}`;
  }

  private dispatchMcpUrl(agentId: string): string {
    return `${this.config.tls ? "https" : "http"}://127.0.0.1:${this.config.port}/api/mcp/${agentId}`;
  }

  private shellEscape(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
  }

  private async validateWorkingDirectory(rawCwd: string): Promise<string> {
    const cwd = rawCwd.startsWith("~/")
      ? path.join(process.env.HOME ?? "/", rawCwd.slice(2))
      : rawCwd === "~"
        ? process.env.HOME ?? "/"
        : rawCwd;

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
        codex_args AS "agentArgs",
        full_access AS "fullAccess",
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
        git_context AS "gitContext",
        git_context_stale AS "gitContextStale",
        git_context_updated_at AS "gitContextUpdatedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM agents
    `;
  }

  private newAgentId(): string {
    return `agt_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  }

  /** Extract agent ID from a session name like "dispatch_agt_abc123_my-task". */
  private agentIdFromSessionName(sessionName: string): string {
    const match = sessionName.match(/(?:dispatch|hostess)_(agt_[a-f0-9]{12})/);
    return match?.[1] ?? sessionName.replace(/^(dispatch|hostess)_/, "");
  }

  private toSessionName(agentId: string, agentName?: string): string {
    if (!agentName) {
      return `dispatch_${agentId}`;
    }
    // Sanitize: tmux disallows colons and periods in session names.
    // Collapse whitespace/special chars to hyphens, truncate to keep it readable.
    const slug = agentName
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 30);
    return `dispatch_${agentId}_${slug}`;
  }

  private defaultMediaDir(agentId: string): string {
    return path.join(this.config.mediaRoot, agentId);
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Unknown error";
  }

  private async readExitFile(sessionName: string): Promise<number | null> {
    try {
      const content = await readFile(`/tmp/dispatch_${sessionName}.exit`, "utf-8");
      const match = content.trim().match(/^EXIT:(\d+)$/);
      return match ? Number(match[1]) : null;
    } catch {
      return null;
    }
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
