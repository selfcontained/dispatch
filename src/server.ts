import path from "node:path";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { existsSync, watch, type FSWatcher } from "node:fs";

import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify from "fastify";
import type { FastifyReply } from "fastify";
import type WebSocket from "ws";
import pty from "node-pty";

import { AgentError, AgentManager } from "./agents/manager.js";
import type { AgentGitContext, AgentRecord } from "./agents/manager.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { runCommand } from "./lib/run-command.js";
import {
  RepoConfigError,
  isWorktreeMode,
  resolveRepoConfig,
  writeWorktreeMode
} from "./repo-config.js";
import { TerminalTokenStore } from "./terminal/token-store.js";

const config = loadConfig();
const app = Fastify({ logger: true });
const pool = createPool(config);
const agentManager = new AgentManager(pool, app.log, config);
const terminalTokenStore = new TerminalTokenStore(60_000);

const AGENT_LATEST_EVENT_TYPES = ["working", "blocked", "waiting_user", "done", "idle"] as const;
type AgentLatestEventType = (typeof AGENT_LATEST_EVENT_TYPES)[number];
type UiEvent =
  | { type: "snapshot"; agents: AgentRecord[] }
  | { type: "agent.upsert"; agent: AgentRecord }
  | { type: "agent.deleted"; agentId: string }
  | { type: "media.changed"; agentId: string }
  | { type: "media.seen"; agentId: string; keys: string[] };

class UiEventBroker {
  private clients = new Set<NodeJS.WritableStream>();
  private nextId = 1;

  subscribe(stream: NodeJS.WritableStream): () => void {
    this.clients.add(stream);
    return () => {
      this.clients.delete(stream);
    };
  }

  publish(event: UiEvent): void {
    this.write(event);
  }

  sendSnapshot(stream: NodeJS.WritableStream, agents: AgentRecord[]): void {
    this.write({ type: "snapshot", agents }, stream);
  }

  private write(event: UiEvent, target?: NodeJS.WritableStream): void {
    const payload = `id: ${this.nextId++}\ndata: ${JSON.stringify(event)}\n\n`;
    if (target) {
      target.write(payload);
      return;
    }

    for (const client of this.clients) {
      try {
        client.write(payload);
      } catch {
        this.clients.delete(client);
      }
    }
  }
}

const uiEventBroker = new UiEventBroker();
const mediaWatchers = new Map<string, FSWatcher>();
const mediaDebounceTimers = new Map<string, NodeJS.Timeout>();
const runtimeCwdCache = new Map<string, { value: string; expiresAt: number }>();
const RUNTIME_CWD_CACHE_TTL_MS = 10_000;
const PROBE_COMMAND_TIMEOUT_MS = 500;
const GIT_CONTEXT_REFRESH_INTERVAL_MS = 15_000;
const GIT_CONTEXT_REFRESH_CONCURRENCY = 2;
const GIT_DIAGNOSTICS_HISTORY_LIMIT = 200;
const pendingGitRefreshAgentIds = new Set<string>();
const activeGitRefreshAgentIds = new Set<string>();
const pendingGitRefreshEnqueuedAt = new Map<string, number>();
const gitRefreshDurationsMs: number[] = [];
const gitRefreshAgentDiagnostics = new Map<
  string,
  {
    lastQueuedAt: number | null;
    lastStartedAt: number | null;
    lastCompletedAt: number | null;
    lastDurationMs: number | null;
    lastResult: "updated" | "unchanged" | "probe_error" | "failed" | "skipped" | null;
    lastError: string | null;
  }
>();
const gitRefreshCounters = {
  enqueued: 0,
  started: 0,
  completed: 0,
  updated: 0,
  unchanged: 0,
  probeErrors: 0,
  failed: 0,
  timedOut: 0,
  skipped: 0
};
let gitContextRefreshTimer: NodeJS.Timeout | null = null;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webDistDir = path.resolve(__dirname, "../web/dist");
const legacyPublicDir = path.resolve(__dirname, "../public");
const staticDir = existsSync(webDistDir) ? webDistDir : legacyPublicDir;

async function registerRoutes() {
  await app.register(fastifyWebsocket);

  await app.register(fastifyStatic, {
    root: staticDir,
    prefix: "/"
  });

  app.get("/api/v1/health", async () => {
    const result = await pool.query("SELECT NOW() AS now");

    return {
      status: "ok",
      db: "ok",
      now: result.rows[0]?.now
    };
  });

  app.get("/api/v1/diagnostics/git-context", async () => {
    const now = Date.now();
    const pendingAges = Array.from(pendingGitRefreshEnqueuedAt.values()).map((queuedAt) =>
      Math.max(0, now - queuedAt)
    );
    const oldestPendingAgeMs = pendingAges.length > 0 ? Math.max(...pendingAges) : null;

    const durations = [...gitRefreshDurationsMs].sort((a, b) => a - b);
    const p50DurationMs = percentile(durations, 0.5);
    const p95DurationMs = percentile(durations, 0.95);
    const maxDurationMs = durations.length > 0 ? durations[durations.length - 1] : null;
    const lastDurationMs =
      gitRefreshDurationsMs.length > 0 ? gitRefreshDurationsMs[gitRefreshDurationsMs.length - 1] : null;

    const agents = Array.from(gitRefreshAgentDiagnostics.entries())
      .map(([agentId, diag]) => ({
        agentId,
        pending: pendingGitRefreshAgentIds.has(agentId),
        active: activeGitRefreshAgentIds.has(agentId),
        lastQueuedAt: toIso(diag.lastQueuedAt),
        lastStartedAt: toIso(diag.lastStartedAt),
        lastCompletedAt: toIso(diag.lastCompletedAt),
        lastDurationMs: diag.lastDurationMs,
        lastResult: diag.lastResult,
        lastError: diag.lastError
      }))
      .sort((a, b) => a.agentId.localeCompare(b.agentId));

    return {
      config: {
        intervalMs: GIT_CONTEXT_REFRESH_INTERVAL_MS,
        concurrency: GIT_CONTEXT_REFRESH_CONCURRENCY,
        probeTimeoutMs: PROBE_COMMAND_TIMEOUT_MS
      },
      queue: {
        pending: pendingGitRefreshAgentIds.size,
        active: activeGitRefreshAgentIds.size,
        oldestPendingAgeMs
      },
      counters: gitRefreshCounters,
      durationsMs: {
        samples: durations.length,
        p50: p50DurationMs,
        p95: p95DurationMs,
        max: maxDurationMs,
        last: lastDurationMs
      },
      agents
    };
  });

  app.get("/api/v1/agents", async () => {
    const agents = await agentManager.listAgents();
    queueGitContextRefresh(agents.map((agent) => agent.id));
    return { agents };
  });

  app.get("/api/v1/agents/git-context", async (request, reply) => {
    const query = request.query as { ids?: unknown };
    const ids =
      typeof query.ids === "string"
        ? query.ids
            .split(",")
            .map((id) => id.trim())
            .filter((id) => id.length > 0)
        : [];

    const idFilter = ids.length > 0 ? new Set(ids) : null;
    const agents = await agentManager.listAgents();
    const targets = idFilter ? agents.filter((agent) => idFilter.has(agent.id)) : agents;

    const contexts = targets.map((agent) => ({
      id: agent.id,
      gitContext: agent.gitContext
    }));
    queueGitContextRefresh(targets.map((agent) => agent.id));

    return { contexts };
  });

  app.get("/api/v1/repo-config", async (request, reply) => {
    const query = request.query as { cwd?: unknown };
    if (typeof query.cwd !== "string" || !query.cwd.trim()) {
      return reply.code(400).send({ error: "cwd query parameter is required." });
    }

    try {
      const resolved = await resolveRepoConfig(query.cwd.trim());
      return resolved;
    } catch (error) {
      return handleRepoConfigError(reply, error);
    }
  });

  app.patch("/api/v1/repo-config", async (request, reply) => {
    const body = request.body as { cwd?: unknown; worktreeMode?: unknown };
    if (typeof body?.cwd !== "string" || !body.cwd.trim()) {
      return reply.code(400).send({ error: "Body must include cwd as a non-empty string." });
    }

    if (!isWorktreeMode(body.worktreeMode)) {
      return reply.code(400).send({ error: "worktreeMode must be one of: ask, auto, off." });
    }

    try {
      const resolved = await writeWorktreeMode(body.cwd.trim(), body.worktreeMode);
      return resolved;
    } catch (error) {
      return handleRepoConfigError(reply, error);
    }
  });

  app.get("/api/v1/events", async (_request, reply) => {
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.hijack();

    const stream = reply.raw;
    const unsubscribe = uiEventBroker.subscribe(stream);
    const heartbeat = setInterval(() => {
      stream.write(": keepalive\n\n");
    }, 20_000);

    try {
      const agents = await agentManager.listAgents();
      uiEventBroker.sendSnapshot(stream, agents);
      queueGitContextRefresh(agents.map((agent) => agent.id));
    } catch (error) {
      app.log.warn({ err: error }, "Failed to load SSE snapshot.");
    }

    stream.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.get("/api/v1/agents/:id", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";
    const agent = await agentManager.getAgent(id);

    if (!agent) {
      return reply.code(404).send({ error: "Agent not found." });
    }
    queueGitContextRefresh([agent.id]);
    return { agent };
  });

  app.post("/api/v1/agents/:id/latest-event", async (request, reply) => {
    const params = request.params as { id?: string };
    const body = request.body as {
      type?: unknown;
      message?: unknown;
      metadata?: unknown;
    };
    const id = params.id ?? "";
    const type = body?.type;
    const message = body?.message;
    const metadata = body?.metadata;

    if (!isAgentLatestEventType(type)) {
      return reply.code(400).send({
        error: `type must be one of: ${AGENT_LATEST_EVENT_TYPES.join(", ")}.`
      });
    }

    if (typeof message !== "string" || !message.trim()) {
      return reply.code(400).send({ error: "message must be a non-empty string." });
    }

    if (
      metadata !== undefined &&
      (metadata === null || typeof metadata !== "object" || Array.isArray(metadata))
    ) {
      return reply.code(400).send({ error: "metadata must be an object when provided." });
    }

    const agent = await agentManager.upsertLatestEvent(id, {
      type,
      message: message.trim(),
      metadata: metadata as Record<string, unknown> | undefined
    });

    queueGitContextRefresh([agent.id]);
    uiEventBroker.publish({ type: "agent.upsert", agent });
    return { agent };
  });

  app.get("/api/v1/agents/:id/media", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";
    const agent = await agentManager.getAgent(id);
    if (!agent) {
      return reply.code(404).send({ error: "Agent not found." });
    }

    const mediaDir = resolveMediaDir(agent.id, agent.mediaDir);
    await mkdir(mediaDir, { recursive: true });
    const files = await listMediaFiles(id, mediaDir);
    const seenKeys = await loadSeenMediaKeys(id, files.map(toMediaKey));
    return {
      files: files.map((file) => ({
        ...file,
        seen: seenKeys.has(toMediaKey(file))
      }))
    };
  });

  app.get("/api/v1/agents/:id/media/:file", async (request, reply) => {
    const params = request.params as { id?: string; file?: string };
    const id = params.id ?? "";
    const agent = await agentManager.getAgent(id);
    if (!agent) {
      return reply.code(404).send({ error: "Agent not found." });
    }

    const file = params.file ?? "";
    if (!/^[A-Za-z0-9._-]+$/.test(file)) {
      return reply.code(400).send({ error: "Invalid media file name." });
    }

    const filePath = path.join(resolveMediaDir(agent.id, agent.mediaDir), file);
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat || !fileStat.isFile()) {
      return reply.code(404).send({ error: "Media file not found." });
    }

    return reply.type(mimeType(file)).send(await readFile(filePath));
  });

  app.post("/api/v1/agents/:id/media/seen", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";
    const agent = await agentManager.getAgent(id);
    if (!agent) {
      return reply.code(404).send({ error: "Agent not found." });
    }

    const body = request.body as { keys?: unknown } | undefined;
    if (!Array.isArray(body?.keys) || !body.keys.every((key) => typeof key === "string")) {
      return reply.code(400).send({ error: "keys must be an array of strings." });
    }

    const keys = Array.from(
      new Set(
        body.keys
          .map((key) => key.trim())
          .filter((key) => isValidMediaKey(key))
      )
    );

    if (keys.length === 0) {
      return { ok: true, updated: 0 };
    }

    await markSeenMediaKeys(id, keys);
    uiEventBroker.publish({ type: "media.seen", agentId: id, keys });
    return { ok: true, updated: keys.length };
  });

  app.post("/api/v1/agents", async (request, reply) => {
    const body = request.body as {
      name?: unknown;
      type?: unknown;
      cwd?: unknown;
      codexArgs?: unknown;
      fullAccess?: unknown;
    };

    if (typeof body?.cwd !== "string") {
      return reply.code(400).send({ error: "Body must include cwd as a string." });
    }

    const codexArgsValid =
      body.codexArgs === undefined ||
      (Array.isArray(body.codexArgs) && body.codexArgs.every((item) => typeof item === "string"));

    if (!codexArgsValid) {
      return reply.code(400).send({ error: "codexArgs must be an array of strings." });
    }

    if (body.type !== undefined && body.type !== "codex" && body.type !== "claude") {
      return reply.code(400).send({ error: "type must be either codex or claude when provided." });
    }

    if (body.fullAccess !== undefined && typeof body.fullAccess !== "boolean") {
      return reply.code(400).send({ error: "fullAccess must be a boolean when provided." });
    }

    const codexArgs = body.codexArgs as string[] | undefined;
    const resolvedCodexArgs =
      body.fullAccess === true
        ? Array.from(new Set([...(codexArgs ?? []), "--dangerously-bypass-approvals-and-sandbox"]))
        : codexArgs;

    try {
      const agent = await agentManager.createAgent({
        name: typeof body.name === "string" ? body.name : undefined,
        type: body.type === "claude" ? "claude" : "codex",
        cwd: body.cwd,
        codexArgs: resolvedCodexArgs
      });
      ensureMediaWatch(agent.id, resolveMediaDir(agent.id, agent.mediaDir));
      queueGitContextRefresh([agent.id]);
      uiEventBroker.publish({ type: "agent.upsert", agent });
      return reply.code(201).send({ agent });
    } catch (error) {
      return handleAgentError(reply, error);
    }
  });

  app.post("/api/v1/agents/:id/start", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";

    try {
      const agent = await agentManager.startAgent(id);
      ensureMediaWatch(agent.id, resolveMediaDir(agent.id, agent.mediaDir));
      queueGitContextRefresh([agent.id]);
      uiEventBroker.publish({ type: "agent.upsert", agent });
      return { agent };
    } catch (error) {
      return handleAgentError(reply, error);
    }
  });

  app.post("/api/v1/agents/:id/stop", async (request, reply) => {
    const params = request.params as { id?: string };
    const body = request.body as { force?: unknown } | undefined;
    const id = params.id ?? "";

    if (body?.force !== undefined && typeof body.force !== "boolean") {
      return reply.code(400).send({ error: "force must be a boolean when provided." });
    }

    try {
      const agent = await agentManager.stopAgent(id, { force: body?.force as boolean | undefined });
      queueGitContextRefresh([agent.id]);
      uiEventBroker.publish({ type: "agent.upsert", agent });
      return { agent };
    } catch (error) {
      return handleAgentError(reply, error);
    }
  });

  app.delete("/api/v1/agents/:id", async (request, reply) => {
    const params = request.params as { id?: unknown };
    const query = request.query as { force?: unknown };

    if (typeof params.id !== "string") {
      return reply.code(400).send({ error: "Missing agent id." });
    }

    const force = query.force === "true" || query.force === true;
    if (query.force !== undefined && typeof query.force !== "string" && typeof query.force !== "boolean") {
      return reply.code(400).send({ error: "force must be true or false." });
    }

    try {
      const existing = await agentManager.getAgent(params.id);
      await agentManager.deleteAgent(params.id, force);
      if (existing) {
        stopMediaWatch(existing.id);
        pendingGitRefreshAgentIds.delete(existing.id);
        pendingGitRefreshEnqueuedAt.delete(existing.id);
        activeGitRefreshAgentIds.delete(existing.id);
        gitRefreshAgentDiagnostics.delete(existing.id);
        uiEventBroker.publish({ type: "agent.deleted", agentId: existing.id });
      }
      return reply.code(204).send();
    } catch (error) {
      return handleAgentError(reply, error);
    }
  });

  app.post("/api/v1/agents/:id/terminal/token", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";

    try {
      const agent = await agentManager.getAgent(id);
      if (!agent) {
        return reply.code(404).send({ error: "Agent not found." });
      }
      if (agent.status !== "running") {
        return reply.code(409).send({ error: "Agent is not running." });
      }
      if (!agent.tmuxSession) {
        return reply.code(500).send({ error: "Agent is missing tmux session metadata." });
      }
      const token = terminalTokenStore.issue(id);
      return {
        token,
        wsUrl: `/api/v1/agents/${id}/terminal/ws?token=${token}`
      };
    } catch (error) {
      // Keep UI state in sync when getTerminalSession corrected a stale running status.
      const refreshed = await agentManager.getAgent(id);
      if (refreshed) {
        queueGitContextRefresh([refreshed.id]);
        uiEventBroker.publish({ type: "agent.upsert", agent: refreshed });
      }
      return handleAgentError(reply, error);
    }
  });

  app.get(
    "/api/v1/agents/:id/terminal/ws",
    { websocket: true },
    async (connection, request) => {
      const socket = connection.socket;
      const params = request.params as { id?: string };
      const query = request.query as { token?: string; cols?: string; rows?: string };
      const agentId = params.id ?? "";
      const token = query.token ?? "";

      if (!terminalTokenStore.consume(agentId, token)) {
        socket.send(JSON.stringify({ type: "error", message: "Invalid or expired terminal token." }));
        socket.close(1008, "invalid token");
        return;
      }

      let tmuxSession: string;
      try {
        tmuxSession = await agentManager.getTerminalSession(agentId);
        await runCommand("tmux", ["set-option", "-t", tmuxSession, "mouse", "on"], {
          allowedExitCodes: [0]
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Terminal attach failed.";
        socket.send(JSON.stringify({ type: "error", message }));
        socket.close(1011, "attach failed");
        return;
      }

      const cols = Number(query.cols ?? 140);
      const rows = Number(query.rows ?? 42);
      const ptyProcess = pty.spawn("tmux", ["attach-session", "-t", tmuxSession], {
        name: "xterm-256color",
        cols: Number.isFinite(cols) ? cols : 140,
        rows: Number.isFinite(rows) ? rows : 42
      });

      const sendJson = (payload: unknown): void => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify(payload));
        }
      };

      ptyProcess.onData((data) => {
        sendJson({ type: "output", data });
      });

      ptyProcess.onExit((event) => {
        sendJson({ type: "exit", exitCode: event.exitCode });
        socket.close(1000, "terminal exited");
      });

      const heartbeatTimer = setInterval(() => {
        sendJson({ type: "heartbeat", ts: Date.now() });
      }, 20_000);

      socket.on("message", (buffer) => {
        const message = decodeClientMessage(buffer);
        if (!message) {
          sendJson({ type: "error", message: "Invalid message payload." });
          return;
        }

        if (message.type === "input") {
          if (!message.data) {
            return;
          }
          ptyProcess.write(message.data);
          return;
        }

        if (message.type === "resize") {
          if (message.cols > 0 && message.rows > 0) {
            ptyProcess.resize(message.cols, message.rows);
          }
        }
      });

      socket.on("close", () => {
        clearInterval(heartbeatTimer);
        try {
          ptyProcess.kill();
        } catch {}
      });
    }
  );

}

async function start() {
  await runMigrations();
  await agentManager.reconcileAgents();
  const agents = await agentManager.listAgents();
  for (const agent of agents) {
    ensureMediaWatch(agent.id, resolveMediaDir(agent.id, agent.mediaDir));
  }
  queueGitContextRefresh(agents.map((agent) => agent.id));
  startGitContextRefreshLoop();
  await registerRoutes();

  await app.listen({
    host: config.host,
    port: config.port
  });
}

start().catch(async (error) => {
  app.log.error(error);
  await shutdown(1);
});

process.on("SIGINT", async () => {
  await shutdown(0);
});

process.on("SIGTERM", async () => {
  await shutdown(0);
});

function handleAgentError(reply: FastifyReply, error: unknown) {
  if (error instanceof AgentError) {
    return reply.code(error.statusCode).send({ error: error.message });
  }

  const message = error instanceof Error ? error.message : "Unknown error.";
  return reply.code(500).send({ error: message });
}

function handleRepoConfigError(reply: FastifyReply, error: unknown) {
  if (error instanceof RepoConfigError) {
    return reply.code(error.statusCode).send({ error: error.message });
  }

  const message = error instanceof Error ? error.message : "Unknown error.";
  return reply.code(500).send({ error: message });
}

function ensureGitRefreshAgentDiagnostics(agentId: string): {
  lastQueuedAt: number | null;
  lastStartedAt: number | null;
  lastCompletedAt: number | null;
  lastDurationMs: number | null;
  lastResult: "updated" | "unchanged" | "probe_error" | "failed" | "skipped" | null;
  lastError: string | null;
} {
  const existing = gitRefreshAgentDiagnostics.get(agentId);
  if (existing) {
    return existing;
  }
  const created = {
    lastQueuedAt: null,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastDurationMs: null,
    lastResult: null,
    lastError: null
  };
  gitRefreshAgentDiagnostics.set(agentId, created);
  return created;
}

function recordGitRefreshCompletion(
  agentId: string,
  startedAt: number,
  result: "updated" | "unchanged" | "probe_error" | "failed" | "skipped",
  errorMessage: string | null
): void {
  const completedAt = Date.now();
  const durationMs = Math.max(0, completedAt - startedAt);
  gitRefreshCounters.completed += 1;
  if (result === "updated") {
    gitRefreshCounters.updated += 1;
  } else if (result === "unchanged") {
    gitRefreshCounters.unchanged += 1;
  } else if (result === "probe_error") {
    gitRefreshCounters.probeErrors += 1;
  } else if (result === "failed") {
    gitRefreshCounters.failed += 1;
  } else if (result === "skipped") {
    gitRefreshCounters.skipped += 1;
  }

  if (result === "failed" && errorMessage?.includes("Command timed out")) {
    gitRefreshCounters.timedOut += 1;
  }

  gitRefreshDurationsMs.push(durationMs);
  if (gitRefreshDurationsMs.length > GIT_DIAGNOSTICS_HISTORY_LIMIT) {
    gitRefreshDurationsMs.shift();
  }

  const diag = ensureGitRefreshAgentDiagnostics(agentId);
  diag.lastCompletedAt = completedAt;
  diag.lastDurationMs = durationMs;
  diag.lastResult = result;
  diag.lastError = errorMessage;
}

function percentile(sortedValues: number[], quantile: number): number | null {
  if (sortedValues.length === 0) {
    return null;
  }
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.floor((sortedValues.length - 1) * quantile))
  );
  return sortedValues[index] ?? null;
}

function toIso(epochMs: number | null): string | null {
  if (epochMs === null) {
    return null;
  }
  return new Date(epochMs).toISOString();
}

function queueGitContextRefresh(agentIds: string[]): void {
  for (const agentId of agentIds) {
    if (!agentId) {
      continue;
    }
    const wasPending = pendingGitRefreshAgentIds.has(agentId);
    const wasActive = activeGitRefreshAgentIds.has(agentId);
    if (!wasPending && !wasActive) {
      pendingGitRefreshEnqueuedAt.set(agentId, Date.now());
    }
    ensureGitRefreshAgentDiagnostics(agentId).lastQueuedAt = Date.now();
    pendingGitRefreshAgentIds.add(agentId);
    gitRefreshCounters.enqueued += 1;
  }
  void drainGitContextRefreshQueue();
}

function startGitContextRefreshLoop(): void {
  if (gitContextRefreshTimer) {
    return;
  }
  gitContextRefreshTimer = setInterval(() => {
    void refreshAllAgentGitContexts();
  }, GIT_CONTEXT_REFRESH_INTERVAL_MS);
}

function stopGitContextRefreshLoop(): void {
  if (!gitContextRefreshTimer) {
    return;
  }
  clearInterval(gitContextRefreshTimer);
  gitContextRefreshTimer = null;
}

async function refreshAllAgentGitContexts(): Promise<void> {
  try {
    const agents = await agentManager.listAgents();
    queueGitContextRefresh(agents.map((agent) => agent.id));
  } catch (error) {
    app.log.warn({ err: error }, "Failed to queue git context refresh.");
  }
}

async function drainGitContextRefreshQueue(): Promise<void> {
  while (
    activeGitRefreshAgentIds.size < GIT_CONTEXT_REFRESH_CONCURRENCY &&
    pendingGitRefreshAgentIds.size > 0
  ) {
    const nextAgentId = pendingGitRefreshAgentIds.values().next().value as string | undefined;
    if (!nextAgentId) {
      return;
    }

    pendingGitRefreshAgentIds.delete(nextAgentId);
    pendingGitRefreshEnqueuedAt.delete(nextAgentId);
    if (activeGitRefreshAgentIds.has(nextAgentId)) {
      continue;
    }

    activeGitRefreshAgentIds.add(nextAgentId);
    gitRefreshCounters.started += 1;
    const startedAt = Date.now();
    const diag = ensureGitRefreshAgentDiagnostics(nextAgentId);
    diag.lastStartedAt = startedAt;
    diag.lastError = null;
    void refreshAgentGitContext(nextAgentId)
      .then((result) => {
        recordGitRefreshCompletion(nextAgentId, startedAt, result, null);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        recordGitRefreshCompletion(nextAgentId, startedAt, "failed", message);
        app.log.warn({ err: error, agentId: nextAgentId }, "Git context refresh failed.");
      })
      .finally(() => {
        activeGitRefreshAgentIds.delete(nextAgentId);
        void drainGitContextRefreshQueue();
      });
  }
}

async function refreshAgentGitContext(
  agentId: string
): Promise<"updated" | "unchanged" | "probe_error" | "skipped"> {
  const agent = await agentManager.getAgent(agentId);
  if (!agent) {
    return "skipped";
  }

  const cwd = await resolveAgentGitCwd(agent);
  const probe = await probeGitContext(cwd);

  if (probe.status === "error") {
    await persistAgentGitContext(agentId, agent.gitContext, true);
    return "probe_error";
  }

  const nextContext = probe.value;
  const shouldPublish =
    agent.gitContextStale || !areGitContextsEqual(agent.gitContext, nextContext);

  await persistAgentGitContext(agentId, nextContext, false);
  if (!shouldPublish) {
    return "unchanged";
  }

  const refreshed = await agentManager.getAgent(agentId);
  if (refreshed) {
    uiEventBroker.publish({ type: "agent.upsert", agent: refreshed });
  }
  return "updated";
}

async function persistAgentGitContext(
  agentId: string,
  gitContext: AgentGitContext | null,
  stale: boolean
): Promise<void> {
  await pool.query(
    `
    UPDATE agents
    SET git_context = $2::jsonb,
        git_context_stale = $3,
        git_context_updated_at = NOW()
    WHERE id = $1
    `,
    [agentId, gitContext ? JSON.stringify(gitContext) : null, stale]
  );
}

function areGitContextsEqual(
  left: AgentGitContext | null,
  right: AgentGitContext | null
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.repoRoot === right.repoRoot &&
    left.branch === right.branch &&
    left.worktreePath === right.worktreePath &&
    left.worktreeName === right.worktreeName &&
    left.isWorktree === right.isWorktree
  );
}

async function resolveAgentGitCwd(agent: AgentRecord): Promise<string> {
  const fallback = agent.cwd;
  const session = agent.tmuxSession?.trim();
  if (!session) {
    return fallback;
  }

  if (agent.status !== "running" && agent.status !== "creating") {
    return fallback;
  }

  const cacheKey = `${agent.id}:${session}`;
  const cached = runtimeCwdCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  try {
    const result = await runCommand("tmux", ["display-message", "-p", "-t", session, "#{pane_current_path}"], {
      allowedExitCodes: [0, 1],
      timeoutMs: PROBE_COMMAND_TIMEOUT_MS
    });
    const cwd = result.stdout.trim();
    if (result.exitCode !== 0 || !cwd) {
      return fallback;
    }
    runtimeCwdCache.set(cacheKey, { value: cwd, expiresAt: now + RUNTIME_CWD_CACHE_TTL_MS });
    return cwd;
  } catch {
    return fallback;
  }
}

async function probeGitContext(
  cwd: string
): Promise<{ status: "ok"; value: AgentGitContext | null } | { status: "error" }> {
  try {
    const inside = await runCommand(
      "git",
      ["-C", cwd, "rev-parse", "--is-inside-work-tree"],
      { allowedExitCodes: [0, 128], timeoutMs: PROBE_COMMAND_TIMEOUT_MS }
    );
    if (inside.exitCode !== 0 || inside.stdout !== "true") {
      return { status: "ok", value: null };
    }

    const repoRoot = await resolveRepoRoot(cwd);
    const checkoutRoot = normalizePath(
      (
        await runCommand("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
          allowedExitCodes: [0],
          timeoutMs: PROBE_COMMAND_TIMEOUT_MS
        })
      ).stdout
    );

    let branch = (
      await runCommand("git", ["-C", cwd, "symbolic-ref", "--short", "-q", "HEAD"], {
        allowedExitCodes: [0, 1],
        timeoutMs: PROBE_COMMAND_TIMEOUT_MS
      })
    ).stdout;
    if (!branch) {
      branch = (
        await runCommand("git", ["-C", cwd, "rev-parse", "--short", "HEAD"], {
          allowedExitCodes: [0],
          timeoutMs: PROBE_COMMAND_TIMEOUT_MS
        })
      ).stdout;
    }

    return {
      status: "ok",
      value: {
        repoRoot,
        branch,
        worktreePath: checkoutRoot,
        worktreeName: path.basename(checkoutRoot),
        isWorktree: checkoutRoot !== repoRoot
      }
    };
  } catch {
    return { status: "error" };
  }
}

async function resolveRepoRoot(cwd: string): Promise<string> {
  const commonDirResult = await runCommand(
    "git",
    ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { allowedExitCodes: [0, 128], timeoutMs: PROBE_COMMAND_TIMEOUT_MS }
  );

  if (commonDirResult.exitCode === 0 && commonDirResult.stdout) {
    const commonDir = normalizePath(commonDirResult.stdout);
    if (path.basename(commonDir) === ".git") {
      return normalizePath(path.dirname(commonDir));
    }
  }

  const fallbackCommonDirResult = await runCommand(
    "git",
    ["-C", cwd, "rev-parse", "--git-common-dir"],
    { allowedExitCodes: [0, 128], timeoutMs: PROBE_COMMAND_TIMEOUT_MS }
  );
  if (fallbackCommonDirResult.exitCode === 0 && fallbackCommonDirResult.stdout) {
    const commonDir = fallbackCommonDirResult.stdout;
    const absoluteCommonDir = normalizePath(
      path.isAbsolute(commonDir) ? commonDir : path.resolve(cwd, commonDir)
    );
    if (path.basename(absoluteCommonDir) === ".git") {
      return normalizePath(path.dirname(absoluteCommonDir));
    }
  }

  return normalizePath(
    (
      await runCommand("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
        allowedExitCodes: [0],
        timeoutMs: PROBE_COMMAND_TIMEOUT_MS
      })
    ).stdout
  );
}

function normalizePath(value: string): string {
  const resolved = path.resolve(value);
  const trimmed = resolved.replace(/[\\/]+$/, "");
  return trimmed.length > 0 ? trimmed : resolved;
}

function decodeClientMessage(
  buffer: WebSocket.RawData
):
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | null {
  try {
    const asString = typeof buffer === "string" ? buffer : buffer.toString();
    const parsed = JSON.parse(asString) as {
      type?: unknown;
      data?: unknown;
      cols?: unknown;
      rows?: unknown;
    };
    if (parsed.type === "input" && typeof parsed.data === "string") {
      return {
        type: "input",
        data: parsed.data
      };
    }

    if (
      parsed.type === "resize" &&
      typeof parsed.cols === "number" &&
      typeof parsed.rows === "number"
    ) {
      return {
        type: "resize",
        cols: parsed.cols,
        rows: parsed.rows
      };
    }

    return null;
  } catch {
    return null;
  }
}

async function listMediaFiles(
  agentId: string,
  mediaDir: string
): Promise<Array<{ name: string; size: number; updatedAt: string; url: string }>> {
  const dirEntries = await readdir(mediaDir, { withFileTypes: true }).catch(() => []);
  const rows: Array<{ name: string; size: number; updatedAt: string; url: string; mtimeMs: number }> = [];

  for (const entry of dirEntries) {
    if (!entry.isFile()) {
      continue;
    }

    if (!isImageFile(entry.name)) {
      continue;
    }

    const absolutePath = path.join(mediaDir, entry.name);
    const fileStat = await stat(absolutePath).catch(() => null);
    if (!fileStat) {
      continue;
    }

    rows.push({
      name: entry.name,
      size: fileStat.size,
      updatedAt: fileStat.mtime.toISOString(),
      url: `/api/v1/agents/${agentId}/media/${encodeURIComponent(entry.name)}`,
      mtimeMs: fileStat.mtimeMs
    });
  }

  return rows
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 50)
    .map(({ mtimeMs: _drop, ...rest }) => rest);
}

function toMediaKey(file: { name: string; updatedAt: string }): string {
  return `${file.name}:${file.updatedAt}`;
}

function isValidMediaKey(key: string): boolean {
  if (key.length === 0 || key.length > 1024) {
    return false;
  }

  return !/[\u0000-\u001F]/.test(key);
}

async function loadSeenMediaKeys(agentId: string, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) {
    return new Set();
  }

  const result = await pool.query<{ mediaKey: string }>(
    `
    SELECT media_key AS "mediaKey"
    FROM media_seen
    WHERE agent_id = $1 AND media_key = ANY($2::text[])
    `,
    [agentId, keys]
  );

  return new Set(result.rows.map((row) => row.mediaKey));
}

async function markSeenMediaKeys(agentId: string, keys: string[]): Promise<void> {
  if (keys.length === 0) {
    return;
  }

  await pool.query(
    `
    INSERT INTO media_seen (agent_id, media_key, seen_at)
    SELECT $1, key, NOW()
    FROM UNNEST($2::text[]) AS key
    ON CONFLICT (agent_id, media_key) DO UPDATE
      SET seen_at = EXCLUDED.seen_at
    `,
    [agentId, keys]
  );
}

function isImageFile(name: string): boolean {
  return /\.(png|jpg|jpeg|gif|webp)$/i.test(name);
}

function mimeType(name: string): string {
  if (/\.png$/i.test(name)) {
    return "image/png";
  }

  if (/\.jpe?g$/i.test(name)) {
    return "image/jpeg";
  }

  if (/\.gif$/i.test(name)) {
    return "image/gif";
  }

  if (/\.webp$/i.test(name)) {
    return "image/webp";
  }

  return "application/octet-stream";
}

function resolveMediaDir(agentId: string, mediaDir: string | null): string {
  return mediaDir ?? path.join(config.mediaRoot, agentId);
}

let shuttingDown = false;
async function shutdown(code: number): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  stopGitContextRefreshLoop();
  stopAllMediaWatches();
  await pool.end().catch(() => null);
  await app.close().catch(() => null);
  process.exit(code);
}

function ensureMediaWatch(agentId: string, mediaDir: string): void {
  if (mediaWatchers.has(agentId)) {
    return;
  }

  mkdir(mediaDir, { recursive: true })
    .then(() => {
      if (mediaWatchers.has(agentId)) {
        return;
      }

      const watcher = watch(mediaDir, () => {
        scheduleMediaEvent(agentId);
      });

      watcher.on("error", (error) => {
        app.log.warn({ err: error, agentId, mediaDir }, "Media watcher error.");
        stopMediaWatch(agentId);
      });

      mediaWatchers.set(agentId, watcher);
    })
    .catch((error) => {
      app.log.warn({ err: error, agentId, mediaDir }, "Unable to initialize media watch.");
    });
}

function scheduleMediaEvent(agentId: string): void {
  const existing = mediaDebounceTimers.get(agentId);
  if (existing) {
    clearTimeout(existing);
  }

  const timer = setTimeout(() => {
    mediaDebounceTimers.delete(agentId);
    uiEventBroker.publish({ type: "media.changed", agentId });
  }, 200);

  mediaDebounceTimers.set(agentId, timer);
}

function stopMediaWatch(agentId: string): void {
  const watcher = mediaWatchers.get(agentId);
  if (watcher) {
    watcher.close();
    mediaWatchers.delete(agentId);
  }

  const timer = mediaDebounceTimers.get(agentId);
  if (timer) {
    clearTimeout(timer);
    mediaDebounceTimers.delete(agentId);
  }
}

function isAgentLatestEventType(value: unknown): value is AgentLatestEventType {
  return typeof value === "string" && AGENT_LATEST_EVENT_TYPES.includes(value as AgentLatestEventType);
}

function stopAllMediaWatches(): void {
  for (const agentId of mediaWatchers.keys()) {
    stopMediaWatch(agentId);
  }
}
