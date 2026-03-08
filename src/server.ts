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
import type { AgentRecord } from "./agents/manager.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { runCommand } from "./lib/run-command.js";
import { TerminalTokenStore } from "./terminal/token-store.js";
import { TmuxTerminal } from "./terminal/tmux-terminal.js";

const config = loadConfig();
const app = Fastify({ logger: true });
const pool = createPool(config);
const agentManager = new AgentManager(pool, app.log, config);
const terminalTokenStore = new TerminalTokenStore(60_000);

type UiEvent =
  | { type: "snapshot"; agents: AgentRecord[] }
  | { type: "agent.upsert"; agent: AgentRecord }
  | { type: "agent.deleted"; agentId: string }
  | { type: "media.changed"; agentId: string };

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

  app.get("/api/v1/agents", async () => {
    const agents = await agentManager.listAgents();
    return { agents };
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
    return { files };
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

  app.post("/api/v1/agents", async (request, reply) => {
    const body = request.body as {
      name?: unknown;
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
        cwd: body.cwd,
        codexArgs: resolvedCodexArgs
      });
      ensureMediaWatch(agent.id, resolveMediaDir(agent.id, agent.mediaDir));
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
      await agentManager.getTerminalSession(id);
      const token = terminalTokenStore.issue(id);
      return {
        token,
        wsUrl: `/api/v1/agents/${id}/terminal/ws?token=${token}`
      };
    } catch (error) {
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

      const terminal = new TmuxTerminal(tmuxSession);
      const exists = await terminal.hasSession();
      if (!exists) {
        socket.send(JSON.stringify({ type: "error", message: "Agent session no longer exists." }));
        socket.close(1011, "session missing");
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

function stopAllMediaWatches(): void {
  for (const agentId of mediaWatchers.keys()) {
    stopMediaWatch(agentId);
  }
}
