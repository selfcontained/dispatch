import { createReadStream } from "node:fs";
import { access, constants, realpath } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";
import type WebSocket from "ws";

import type { AgentManager, AgentRecord } from "../agents/manager.js";
import type { DiffStatsRefresher } from "../agents/diff-stats-refresher.js";
import { getCopyModeAssistEnabled } from "../copy-mode-assist-settings.js";
import {
  AGENT_TYPES,
  type AgentType,
  CLI_AGENT_TYPES,
  getEnabledAgentTypes,
} from "../agent-type-settings.js";
import { getSetting } from "../db/settings.js";
import { spawn as spawnPty } from "../shared/terminal/bun-pty.js";
import { CopyModeAssistManager } from "../terminal/copy-mode-assist-manager.js";
import {
  type CopyModeObserverManager,
  type TerminalUiState,
} from "../terminal/copy-mode-observer.js";
import { TmuxTerminal } from "../terminal/tmux-terminal.js";
import { RENAME_PROMPT } from "../agents/auto-rename-prompter.js";
import { shouldSuggestSessionRename } from "../agents/tmux/session-name.js";
import {
  type CreateAgentBody,
  type StartupFileUpload,
  MAX_STARTUP_FILE_COUNT,
  createStartupPins,
  parseCreateAgentRequest,
  parseOptionalBooleanField,
  parseOptionalStringArrayField,
} from "./agent-startup.js";
const AGENT_INITIAL_PROMPT_MAX_CHARS = 16_000;
const COPY_MODE_ASSIST_DISABLED_ERROR = "Copy mode assist is disabled.";
const AGENT_LATEST_EVENT_TYPES = [
  "working",
  "blocked",
  "waiting_user",
  "done",
  "idle",
] as const;
const CODEX_FULL_ACCESS_ARG = "--dangerously-bypass-approvals-and-sandbox";
const CLAUDE_FULL_ACCESS_ARG = "--dangerously-skip-permissions";
type AgentLatestEventType = (typeof AGENT_LATEST_EVENT_TYPES)[number];

type AgentRouteDeps = {
  pool: Pool;
  appLog: FastifyBaseLogger;
  agentManager: AgentManager;
  worktreeLocationKey: string;
  validWorktreeLocations: readonly string[];
  publishUiEvent: (event: unknown) => void;
  subscribeUiEvents: (stream: NodeJS.WritableStream) => () => void;
  sendUiSnapshot: (
    stream: NodeJS.WritableStream,
    agents: Array<AgentRecord & { hasStream: boolean }>
  ) => void;
  ackWebNotification: (notificationId: string) => boolean;
  clearFocusedAgents: () => void;
  setFocusedAgent: (agentId: string) => void;
  withStreamFlag: <T extends AgentRecord>(
    agent: T
  ) => T & { hasStream: boolean };
  handleAgentError: (reply: FastifyReply, error: unknown) => FastifyReply;
  startStream: (agentId: string, port: number) => Promise<void>;
  stopStream: (agentId: string, description: string | null) => void;
  hasStream: (agentId: string) => boolean;
  addStreamViewer: (
    agentId: string,
    stream: NodeJS.WritableStream
  ) => () => void;
  issueTerminalToken: (agentId: string) => string;
  consumeTerminalToken: (agentId: string, token: string) => boolean;
  copyModeObserverManager: CopyModeObserverManager;
  copyModeAssistManager: CopyModeAssistManager;
  diffStatsRefresher: DiffStatsRefresher;
  onArchivedAgentsDeleted: (deletedIds: string[]) => void;
  onArchiveError: (agentId: string, error: unknown) => void;
  trackArchivePromise: (agentId: string, archivePromise: Promise<void>) => void;
  sendAgentPrompt: (agentId: string, prompt: string) => Promise<void>;
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function decodeClientMessage(
  buffer: WebSocket.RawData
):
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "interaction"; interaction: "scroll" }
  | null {
  try {
    const asString = typeof buffer === "string" ? buffer : buffer.toString();
    const parsed = JSON.parse(asString) as {
      type?: unknown;
      data?: unknown;
      cols?: unknown;
      rows?: unknown;
      interaction?: unknown;
    };
    if (parsed.type === "input" && typeof parsed.data === "string") {
      return { type: "input", data: parsed.data };
    }
    if (
      parsed.type === "resize" &&
      typeof parsed.cols === "number" &&
      typeof parsed.rows === "number"
    ) {
      return {
        type: "resize",
        cols: parsed.cols,
        rows: parsed.rows,
      };
    }
    if (parsed.type === "interaction" && parsed.interaction === "scroll") {
      return { type: "interaction", interaction: parsed.interaction };
    }
    return null;
  } catch {
    return null;
  }
}

function isAgentLatestEventType(value: unknown): value is AgentLatestEventType {
  return (
    typeof value === "string" &&
    AGENT_LATEST_EVENT_TYPES.includes(value as AgentLatestEventType)
  );
}

export async function registerAgentRoutes(
  app: FastifyInstance,
  deps: AgentRouteDeps
): Promise<void> {
  const isCopyModeAssistEnabled = async (): Promise<boolean> => {
    return getCopyModeAssistEnabled(deps.pool);
  };

  app.get("/api/v1/agents", async () => {
    const agents = await deps.agentManager.listAgents();
    return { agents: agents.map(deps.withStreamFlag) };
  });

  app.get("/api/v1/agents/git-context", async (request) => {
    const query = request.query as { ids?: unknown };
    const ids =
      typeof query.ids === "string"
        ? query.ids
            .split(",")
            .map((id) => id.trim())
            .filter((id) => id.length > 0)
        : [];

    const idFilter = ids.length > 0 ? new Set(ids) : null;
    const agents = await deps.agentManager.listAgents();
    const targets = idFilter
      ? agents.filter((agent) => idFilter.has(agent.id))
      : agents;

    return {
      contexts: targets.map((agent) => ({
        id: agent.id,
        gitContext: agent.gitContext,
      })),
    };
  });

  app.get("/api/v1/events", async (_request, reply) => {
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.hijack();

    const stream = reply.raw;
    const unsubscribe = deps.subscribeUiEvents(stream);
    const heartbeat = setInterval(() => {
      stream.write(": keepalive\n\n");
    }, 20_000);

    try {
      const agents = await deps.agentManager.listAgents();
      deps.sendUiSnapshot(stream, agents.map(deps.withStreamFlag));
    } catch (error) {
      deps.appLog.warn({ err: error }, "Failed to load SSE snapshot.");
    }

    stream.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.post("/api/v1/notifications/ack", async (request, reply) => {
    const body = request.body as { notificationId?: unknown };
    if (typeof body?.notificationId !== "string") {
      return reply
        .code(400)
        .send({ error: "notificationId must be a string." });
    }
    const found = deps.ackWebNotification(body.notificationId);
    deps.appLog.debug(
      { notificationId: body.notificationId, found },
      "Web notification ack received"
    );
    return reply.code(204).send();
  });

  app.post("/api/v1/focus", async (request, reply) => {
    const body = request.body as { agentId?: unknown };
    const agentId = body?.agentId;

    if (agentId === null || agentId === undefined) {
      deps.clearFocusedAgents();
      return reply.code(204).send();
    }

    if (typeof agentId !== "string" || !agentId.trim()) {
      return reply
        .code(400)
        .send({ error: "agentId must be a non-empty string or null." });
    }

    deps.setFocusedAgent(agentId.trim());
    return reply.code(204).send();
  });

  app.get("/api/v1/agents/:id", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";
    const agent = await deps.agentManager.getAgent(id);

    if (!agent) {
      return reply.code(404).send({ error: "Agent not found." });
    }
    return { agent: deps.withStreamFlag(agent) };
  });

  app.get("/api/v1/agents/:id/repo-icon", async (request, reply) => {
    const ALLOWED_ICON_EXTENSIONS = new Set([".svg", ".png", ".ico"]);

    const params = request.params as { id?: string };
    const id = params.id ?? "";
    const agent = await deps.agentManager.getAgent(id);
    if (!agent) {
      return reply.code(404).send({ error: "Agent not found." });
    }

    const iconRelPath = agent.gitContext?.repoIconPath;
    if (!iconRelPath) {
      return reply.code(404).send({ error: "No repo icon." });
    }

    const ext = path.extname(iconRelPath).toLowerCase();
    if (!ALLOWED_ICON_EXTENSIONS.has(ext)) {
      return reply.code(400).send({ error: "Invalid icon extension." });
    }

    const baseDir =
      agent.gitContext?.worktreePath ?? agent.worktreePath ?? agent.cwd;
    const iconAbsPath = path.join(baseDir, iconRelPath);

    let realIconPath: string;
    let realBaseDir: string;
    try {
      realBaseDir = await realpath(baseDir);
      realIconPath = await realpath(iconAbsPath);
    } catch {
      return reply.code(404).send({ error: "Icon file not found." });
    }

    if (
      !realIconPath.startsWith(realBaseDir + path.sep) &&
      realIconPath !== realBaseDir
    ) {
      return reply.code(400).send({ error: "Invalid icon path." });
    }

    try {
      await access(realIconPath, constants.R_OK);
    } catch {
      return reply.code(404).send({ error: "Icon file not readable." });
    }

    const contentType =
      ext === ".svg"
        ? "image/svg+xml"
        : ext === ".png"
          ? "image/png"
          : "image/x-icon";

    return reply
      .type(contentType)
      .header("Cache-Control", "private, max-age=30")
      .header(
        "Content-Security-Policy",
        "default-src 'none'; style-src 'unsafe-inline'"
      )
      .header("X-Content-Type-Options", "nosniff")
      .send(createReadStream(realIconPath));
  });

  app.patch("/api/v1/agents/:id/review-agent-type", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";
    const body = request.body as { reviewAgentType?: unknown } | null;

    let reviewAgentType: (typeof CLI_AGENT_TYPES)[number] | null;
    if (body?.reviewAgentType === null || body?.reviewAgentType === undefined) {
      reviewAgentType = null;
    } else if (
      typeof body.reviewAgentType === "string" &&
      CLI_AGENT_TYPES.includes(
        body.reviewAgentType as (typeof CLI_AGENT_TYPES)[number]
      )
    ) {
      reviewAgentType =
        body.reviewAgentType as (typeof CLI_AGENT_TYPES)[number];
    } else {
      return reply.code(400).send({
        error: `reviewAgentType must be null or one of ${CLI_AGENT_TYPES.join(", ")}.`,
      });
    }

    if (reviewAgentType) {
      const enabledAgentTypes = await getEnabledAgentTypes(deps.pool);
      if (!enabledAgentTypes.includes(reviewAgentType)) {
        return reply.code(400).send({
          error: `${reviewAgentType} agents are disabled in settings.`,
        });
      }
    }

    try {
      await deps.agentManager.updateReviewAgentType(id, reviewAgentType);
      const agent = await deps.agentManager.getAgent(id);
      if (!agent) {
        return reply.code(404).send({ error: "Agent not found." });
      }
      deps.publishUiEvent({
        type: "agent.upsert",
        agent: deps.withStreamFlag(agent),
      });
      return { agent: deps.withStreamFlag(agent) };
    } catch (error) {
      return deps.handleAgentError(reply, error);
    }
  });

  app.post("/api/v1/agents/:id/latest-event", async (request, reply) => {
    const params = request.params as { id?: string };
    const body = request.body as {
      type?: unknown;
      message?: unknown;
      metadata?: unknown;
    };
    const id = params.id ?? "";

    if (!isAgentLatestEventType(body?.type)) {
      return reply.code(400).send({
        error: `type must be one of: ${AGENT_LATEST_EVENT_TYPES.join(", ")}.`,
      });
    }

    if (typeof body.message !== "string" || !body.message.trim()) {
      return reply
        .code(400)
        .send({ error: "message must be a non-empty string." });
    }

    if (
      body.metadata !== undefined &&
      (body.metadata === null ||
        typeof body.metadata !== "object" ||
        Array.isArray(body.metadata))
    ) {
      return reply
        .code(400)
        .send({ error: "metadata must be an object when provided." });
    }

    const agent = await deps.agentManager.upsertLatestEvent(id, {
      type: body.type,
      message: body.message.trim(),
      metadata: body.metadata as Record<string, unknown> | undefined,
    });

    deps.publishUiEvent({
      type: "agent.upsert",
      agent: deps.withStreamFlag(agent),
    });
    return { agent };
  });

  app.post("/api/v1/agents/:id/stream", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";
    const agent = await deps.agentManager.getAgent(id);
    if (!agent) {
      return reply.code(404).send({ error: "Agent not found." });
    }

    const body = request.body as {
      type?: unknown;
      port?: unknown;
      description?: unknown;
    };
    if (body?.type === "stop") {
      const description =
        typeof body.description === "string" ? body.description : null;
      deps.stopStream(id, description);
      return { ok: true };
    }

    if (body?.type === "playwright") {
      if (
        typeof body.port !== "number" ||
        !Number.isFinite(body.port) ||
        body.port < 1
      ) {
        return reply
          .code(400)
          .send({ error: "port must be a positive number." });
      }
      if (deps.hasStream(id)) {
        return reply
          .code(409)
          .send({ error: "Stream already active for this agent." });
      }
      try {
        await deps.startStream(id, body.port);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to start stream.";
        return reply.code(502).send({ error: message });
      }
      return { ok: true };
    }

    return reply
      .code(400)
      .send({ error: "type must be 'playwright' or 'stop'." });
  });

  app.get("/api/v1/agents/:id/stream", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";
    const agent = await deps.agentManager.getAgent(id);
    if (!agent) {
      return reply.code(404).send({ error: "Agent not found." });
    }
    if (!deps.hasStream(id)) {
      return reply
        .code(404)
        .send({ error: "No active stream for this agent." });
    }

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "multipart/x-mixed-replace; boundary=frame",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    raw.flushHeaders();
    if (raw.socket) {
      raw.socket.setNoDelay(true);
    }

    const unsubscribe = deps.addStreamViewer(id, raw);
    reply.raw.on("close", () => {
      unsubscribe();
    });
  });

  app.get("/api/v1/agents/:id/stream/viewer", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";
    const agent = await deps.agentManager.getAgent(id);
    if (!agent) {
      return reply.code(404).send({ error: "Agent not found." });
    }

    const html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>${escapeHtml(agent.name)} — Live Stream</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#0a0a0a;display:flex;align-items:center;justify-content:center;height:100vh;overflow:hidden}
  img{max-width:100%;max-height:100%;object-fit:contain}
  .gone{display:flex;align-items:center;justify-content:center;height:100vh;color:#666;font-family:system-ui;font-size:14px}
</style>
</head><body>
<img id="feed" src="/api/v1/agents/${escapeHtml(id)}/stream" alt="Live stream">
<script>
  const img = document.getElementById('feed');
  img.onerror = () => {
    document.body.innerHTML = '<div class="gone">Stream ended.</div>';
  };
</script>
</body></html>`;
    return reply.type("text/html").send(html);
  });

  app.post("/api/v1/agents", async (request, reply) => {
    let parsedRequest: {
      body: CreateAgentBody;
      startupFiles: StartupFileUpload[];
      isMultipart: boolean;
    };
    try {
      parsedRequest = await parseCreateAgentRequest(request);
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "Invalid request body.",
      });
    }
    const { body, startupFiles } = parsedRequest;

    if (typeof body?.cwd !== "string") {
      return reply
        .code(400)
        .send({ error: "Body must include cwd as a string." });
    }

    let parsedAgentArgs: string[] | undefined;
    let startupLinks: string[] | undefined;
    let fullAccess: boolean | undefined;
    let useWorktree: boolean | undefined;
    let createNewBranch: boolean | undefined;
    let autoReview: boolean | undefined;

    try {
      parsedAgentArgs = parseOptionalStringArrayField(
        body.agentArgs ?? body.codexArgs,
        "agentArgs",
        parsedRequest.isMultipart
      );
      startupLinks = parseOptionalStringArrayField(
        body.startupLinks,
        "startupLinks",
        parsedRequest.isMultipart
      );
      fullAccess = parseOptionalBooleanField(
        body.fullAccess,
        "fullAccess",
        parsedRequest.isMultipart
      );
      useWorktree = parseOptionalBooleanField(
        body.useWorktree,
        "useWorktree",
        parsedRequest.isMultipart
      );
      createNewBranch = parseOptionalBooleanField(
        body.createNewBranch,
        "createNewBranch",
        parsedRequest.isMultipart
      );
      autoReview = parseOptionalBooleanField(
        body.autoReview,
        "autoReview",
        parsedRequest.isMultipart
      );
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "Invalid request body.",
      });
    }

    if (
      body.type !== undefined &&
      !AGENT_TYPES.includes(body.type as AgentType)
    ) {
      return reply.code(400).send({
        error: `type must be ${AGENT_TYPES.join(", ")} when provided.`,
      });
    }

    if (
      body.worktreeBranch !== undefined &&
      typeof body.worktreeBranch !== "string"
    ) {
      return reply
        .code(400)
        .send({ error: "worktreeBranch must be a string when provided." });
    }

    if (body.baseBranch !== undefined && typeof body.baseBranch !== "string") {
      return reply
        .code(400)
        .send({ error: "baseBranch must be a string when provided." });
    }

    if (
      body.initialPrompt !== undefined &&
      typeof body.initialPrompt !== "string"
    ) {
      return reply
        .code(400)
        .send({ error: "initialPrompt must be a string when provided." });
    }

    if (
      typeof body.initialPrompt === "string" &&
      body.initialPrompt.trim().length > AGENT_INITIAL_PROMPT_MAX_CHARS
    ) {
      return reply.code(400).send({
        error: `initialPrompt must be at most ${AGENT_INITIAL_PROMPT_MAX_CHARS} characters when provided.`,
      });
    }

    const agentType: AgentType =
      body.type && AGENT_TYPES.includes(body.type as AgentType)
        ? (body.type as AgentType)
        : "codex";
    const enabledAgentTypes = await getEnabledAgentTypes(deps.pool);
    if (!enabledAgentTypes.includes(agentType)) {
      return reply
        .code(400)
        .send({ error: `${agentType} agents are disabled in settings.` });
    }

    const isTerminalAgent = agentType === "terminal";
    const fullAccessArg =
      agentType === "claude"
        ? CLAUDE_FULL_ACCESS_ARG
        : agentType === "codex"
          ? CODEX_FULL_ACCESS_ARG
          : null;
    const resolvedAgentArgs =
      !isTerminalAgent && fullAccess === true && fullAccessArg
        ? Array.from(new Set([...(parsedAgentArgs ?? []), fullAccessArg]))
        : parsedAgentArgs;

    let startupPins: ReturnType<typeof createStartupPins>;
    try {
      startupPins = createStartupPins(startupLinks ?? []);
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "Invalid startupLinks.",
      });
    }

    try {
      const worktreeLocationRaw = await getSetting(
        deps.pool,
        deps.worktreeLocationKey
      );
      const worktreeLocation =
        worktreeLocationRaw &&
        deps.validWorktreeLocations.includes(worktreeLocationRaw)
          ? worktreeLocationRaw
          : "sibling";

      const agent = await deps.agentManager.createAgent({
        name: typeof body.name === "string" ? body.name : undefined,
        type: agentType,
        cwd: body.cwd,
        agentArgs: resolvedAgentArgs,
        fullAccess: !isTerminalAgent && fullAccess === true,
        useWorktree,
        createNewBranch,
        worktreeBranch:
          typeof body.worktreeBranch === "string"
            ? body.worktreeBranch
            : undefined,
        baseBranch:
          typeof body.baseBranch === "string" ? body.baseBranch : undefined,
        worktreeLocation: worktreeLocation as "sibling" | "nested",
        persona: typeof body.persona === "string" ? body.persona : undefined,
        parentAgentId:
          typeof body.parentAgentId === "string"
            ? body.parentAgentId
            : undefined,
        personaContext:
          typeof body.personaContext === "string"
            ? body.personaContext
            : undefined,
        autoReview: !isTerminalAgent && autoReview === true,
        initialPrompt:
          !isTerminalAgent && typeof body.initialPrompt === "string"
            ? body.initialPrompt.trim() || undefined
            : undefined,
        initialPins: !isTerminalAgent ? startupPins : [],
        initialFiles: !isTerminalAgent ? startupFiles : [],
      });
      deps.publishUiEvent({
        type: "agent.upsert",
        agent: deps.withStreamFlag(agent),
      });
      return reply.code(201).send({ agent });
    } catch (error) {
      return deps.handleAgentError(reply, error);
    }
  });

  app.post("/api/v1/agents/:id/setup/error", async (request, reply) => {
    const params = request.params as { id?: string };
    const body = request.body as { message?: unknown };
    const id = params.id ?? "";
    const message =
      typeof body?.message === "string" ? body.message : "Setup failed.";

    try {
      const agent = await deps.agentManager.markSetupFailed(id, message);
      deps.publishUiEvent({
        type: "agent.upsert",
        agent: deps.withStreamFlag(agent),
      });
      return { ok: true };
    } catch (error) {
      return deps.handleAgentError(reply, error);
    }
  });

  app.post("/api/v1/agents/:id/setup/phase", async (request, reply) => {
    const params = request.params as { id?: string };
    const body = request.body as { phase?: unknown };
    const id = params.id ?? "";

    const validPhases = ["worktree", "env", "deps", "session"];
    if (typeof body?.phase !== "string" || !validPhases.includes(body.phase)) {
      return reply
        .code(400)
        .send({ error: "phase must be one of: worktree, env, deps, session" });
    }

    try {
      await deps.agentManager.updateSetupPhase(
        id,
        body.phase as "worktree" | "env" | "deps" | "session"
      );
      const agent = await deps.agentManager.getAgent(id);
      if (agent) {
        deps.publishUiEvent({
          type: "agent.upsert",
          agent: deps.withStreamFlag(agent),
        });
      }
      return { ok: true };
    } catch (error) {
      return deps.handleAgentError(reply, error);
    }
  });

  app.post("/api/v1/agents/:id/setup/complete", async (request, reply) => {
    const params = request.params as { id?: string };
    const body = request.body as {
      effectiveCwd?: unknown;
      worktreePath?: unknown;
      worktreeBranch?: unknown;
    };
    const id = params.id ?? "";

    if (typeof body?.effectiveCwd !== "string") {
      return reply.code(400).send({ error: "effectiveCwd must be a string." });
    }

    try {
      const agent = await deps.agentManager.completeSetup(id, {
        effectiveCwd: body.effectiveCwd,
        worktreePath:
          typeof body.worktreePath === "string" ? body.worktreePath : null,
        worktreeBranch:
          typeof body.worktreeBranch === "string" ? body.worktreeBranch : null,
      });
      deps.publishUiEvent({
        type: "agent.upsert",
        agent: deps.withStreamFlag(agent),
      });
      return { ok: true };
    } catch (error) {
      return deps.handleAgentError(reply, error);
    }
  });

  app.post("/api/v1/agents/:id/start", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";

    try {
      const agent = await deps.agentManager.startAgent(id);
      deps.publishUiEvent({
        type: "agent.upsert",
        agent: deps.withStreamFlag(agent),
      });
      return { agent };
    } catch (error) {
      return deps.handleAgentError(reply, error);
    }
  });

  app.post("/api/v1/agents/:id/stop", async (request, reply) => {
    const params = request.params as { id?: string };
    const body = request.body as { force?: unknown } | undefined;
    const id = params.id ?? "";

    deps.appLog.info(
      { agentId: id, force: body?.force ?? false },
      "Stop agent requested"
    );

    if (body?.force !== undefined && typeof body.force !== "boolean") {
      return reply
        .code(400)
        .send({ error: "force must be a boolean when provided." });
    }

    try {
      const agent = await deps.agentManager.stopAgent(id, {
        force: body?.force as boolean | undefined,
      });
      deps.publishUiEvent({
        type: "agent.upsert",
        agent: deps.withStreamFlag(agent),
      });
      return { agent };
    } catch (error) {
      return deps.handleAgentError(reply, error);
    }
  });

  app.post("/api/v1/agents/:id/prompt-rename", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";

    try {
      const agent = await deps.agentManager.getAgent(id);
      if (!agent) {
        return reply.code(404).send({ error: "Agent not found." });
      }
      if (agent.status !== "running") {
        return reply
          .code(409)
          .send({ error: "Agent must be running to receive a rename prompt." });
      }
      // Mirror the gates the auto-listener and the sidebar UI apply, so a
      // direct API caller can't paste the rename prompt into an agent that
      // wouldn't be eligible via the UI: terminal agents have no Claude
      // session to read the prompt (it would land in the user's shell),
      // and personas / job agents / already-renamed agents already carry a
      // meaningful name.
      if (agent.type === "terminal") {
        return reply
          .code(409)
          .send({ error: "Terminal agents cannot be prompted to rename." });
      }
      if (
        !shouldSuggestSessionRename(agent.name, agent.id, {
          persona: agent.persona,
          templateId: agent.templateId,
        })
      ) {
        return reply
          .code(409)
          .send({ error: "Agent already has a custom session name." });
      }
      await deps.sendAgentPrompt(id, RENAME_PROMPT);
      return reply.code(204).send();
    } catch (error) {
      return deps.handleAgentError(reply, error);
    }
  });

  app.get("/api/v1/agents/:id/worktree-status", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";

    try {
      return await deps.agentManager.checkWorktreeStatus(id);
    } catch (error) {
      return deps.handleAgentError(reply, error);
    }
  });

  app.get("/api/v1/agents/:id/diff-stats", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";

    const agent = await deps.agentManager.getAgent(id);
    if (!agent) {
      return reply.code(404).send({ error: "Agent not found." });
    }

    // Await the signal so first-paint always sees a fresh value rather
    // than the cold-cache `null` followed by an SSE update milliseconds
    // later. The 3s freshness window inside the refresher still absorbs
    // duplicate signals from multiple tabs hitting this route at once,
    // so awaiting is cheap on warm caches.
    await deps.diffStatsRefresher.signal(id);

    return { diffStats: deps.diffStatsRefresher.getStats(id) };
  });

  app.delete("/api/v1/agents/:id", async (request, reply) => {
    const params = request.params as { id?: unknown };
    const query = request.query as { cleanupWorktree?: unknown };

    if (typeof params.id !== "string") {
      return reply.code(400).send({ error: "Missing agent id." });
    }

    const validCleanupModes = ["auto", "keep", "force"] as const;
    type CleanupMode = (typeof validCleanupModes)[number];
    const cleanupWorktree: CleanupMode =
      typeof query.cleanupWorktree === "string" &&
      (validCleanupModes as readonly string[]).includes(query.cleanupWorktree)
        ? (query.cleanupWorktree as CleanupMode)
        : "auto";

    try {
      const agent = await deps.agentManager.beginArchive(
        params.id,
        cleanupWorktree
      );
      deps.publishUiEvent({
        type: "agent.upsert",
        agent: deps.withStreamFlag(agent),
      });

      const agentId = params.id;
      const archivePromise = deps.agentManager.executeArchive(agentId, {
        onPhaseChange: (updated) => {
          deps.publishUiEvent({
            type: "agent.upsert",
            agent: deps.withStreamFlag(updated),
          });
        },
        onComplete: (deletedIds) => {
          deps.onArchivedAgentsDeleted(deletedIds);
        },
        onError: (error) => {
          deps.onArchiveError(agentId, error);
        },
      });
      deps.trackArchivePromise(agentId, archivePromise);

      return reply.code(202).send({ status: "archiving" });
    } catch (error) {
      return deps.handleAgentError(reply, error);
    }
  });

  app.post("/api/v1/agents/:id/terminal/token", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";

    try {
      const access = await deps.agentManager.getTerminalAccess(id);
      if (access.mode === "inert") {
        return {
          mode: "inert" as const,
          message: access.message,
        };
      }
      const token = deps.issueTerminalToken(id);
      return {
        mode: "tmux" as const,
        token,
        wsUrl: `/api/v1/agents/${id}/terminal/ws?token=${token}`,
      };
    } catch (error) {
      const refreshed = await deps.agentManager.getAgent(id);
      if (refreshed) {
        deps.publishUiEvent({
          type: "agent.upsert",
          agent: deps.withStreamFlag(refreshed),
        });
      }
      return deps.handleAgentError(reply, error);
    }
  });

  app.post(
    "/api/v1/agents/:id/terminal/copy-mode/exit",
    async (request, reply) => {
      const params = request.params as { id?: string };
      const id = params.id ?? "";

      try {
        if (!(await isCopyModeAssistEnabled())) {
          return reply
            .code(409)
            .send({ error: COPY_MODE_ASSIST_DISABLED_ERROR });
        }
        const access = await deps.agentManager.getTerminalAccess(id);
        if (access.mode !== "tmux") {
          return reply.code(409).send({ error: access.message });
        }

        deps.copyModeObserverManager.noteInteraction(
          id,
          access.sessionName,
          "exit_copy_mode"
        );
        const terminal = new TmuxTerminal(access.sessionName);
        await terminal.exitCopyMode();
        return reply.code(204).send();
      } catch (error) {
        return deps.handleAgentError(reply, error);
      }
    }
  );

  app.get("/api/v1/agents/:id/terminal/state", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";

    try {
      if (!(await isCopyModeAssistEnabled())) {
        return reply.code(409).send({ error: COPY_MODE_ASSIST_DISABLED_ERROR });
      }
      const access = await deps.agentManager.getTerminalAccess(id);
      if (access.mode !== "tmux") {
        return reply.code(409).send({ error: access.message });
      }

      return {
        terminalState: await deps.copyModeObserverManager.getState(
          id,
          access.sessionName
        ),
      };
    } catch (error) {
      return deps.handleAgentError(reply, error);
    }
  });

  app.post(
    "/api/v1/agents/:id/terminal/interaction",
    async (request, reply) => {
      const params = request.params as { id?: string };
      const body = request.body as { interaction?: unknown };
      const id = params.id ?? "";

      if (body?.interaction !== "scroll") {
        return reply.code(400).send({ error: "interaction must be 'scroll'." });
      }

      try {
        if (!(await isCopyModeAssistEnabled())) {
          return reply
            .code(409)
            .send({ error: COPY_MODE_ASSIST_DISABLED_ERROR });
        }
        const access = await deps.agentManager.getTerminalAccess(id);
        if (access.mode !== "tmux") {
          return reply.code(409).send({ error: access.message });
        }

        deps.copyModeObserverManager.noteInteraction(
          id,
          access.sessionName,
          body.interaction
        );
        return reply.code(204).send();
      } catch (error) {
        return deps.handleAgentError(reply, error);
      }
    }
  );

  app.get(
    "/api/v1/agents/:id/terminal/ws",
    { websocket: true },
    async (socket, request) => {
      const params = request.params as { id?: string };
      const query = request.query as {
        token?: string;
        cols?: string;
        rows?: string;
      };
      const agentId = params.id ?? "";
      const token = query.token ?? "";

      if (!deps.consumeTerminalToken(agentId, token)) {
        socket.send(
          JSON.stringify({
            type: "error",
            message: "Invalid or expired terminal token.",
          })
        );
        socket.close(1008, "invalid token");
        return;
      }

      let tmuxSession: string;
      const assistState = {
        activeRef: { current: false },
        connectionId: null as string | null,
      };
      try {
        const access = await deps.agentManager.getTerminalAccess(agentId);
        if (access.mode !== "tmux") {
          throw new Error(access.message);
        }
        tmuxSession = access.sessionName;
        // ⚠️ CRITICAL — this gate controls ONLY the copy-mode banner UI
        // and the passive observer. Tmux mouse mode (the actual scroll
        // mechanism) is enabled unconditionally at session launch in
        // runtime.ts. Do NOT pull mouse-mode setup, wheel listeners, or
        // any scroll plumbing inside this if-block — that's how PR #459
        // silently broke scroll for everyone with the toggle off.
        if (await isCopyModeAssistEnabled()) {
          const detachCopyModeViewer =
            deps.copyModeObserverManager.attachViewer(
              agentId,
              tmuxSession,
              randomUUID()
            );
          const assistConnection = await deps.copyModeAssistManager.attach(
            tmuxSession,
            detachCopyModeViewer
          );
          assistState.activeRef = assistConnection.activeRef;
          assistState.connectionId = assistConnection.connectionId;
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Terminal attach failed.";
        socket.send(JSON.stringify({ type: "error", message }));
        socket.close(1011, "attach failed");
        return;
      }
      const cols = Number(query.cols ?? 140);
      const rows = Number(query.rows ?? 42);
      const ptyProcess = spawnPty(
        "tmux",
        ["-u", "attach-session", "-t", tmuxSession],
        {
          name: "xterm-256color",
          cols: Number.isFinite(cols) ? cols : 140,
          rows: Number.isFinite(rows) ? rows : 42,
        }
      );

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
          return;
        }

        if (message.type === "interaction") {
          if (assistState.activeRef.current) {
            deps.copyModeObserverManager.noteInteraction(
              agentId,
              tmuxSession,
              message.interaction
            );
          }
        }
      });

      socket.on("close", () => {
        clearInterval(heartbeatTimer);
        if (assistState.connectionId) {
          void deps.copyModeAssistManager.detach(assistState.connectionId);
        }
        try {
          ptyProcess.kill();
        } catch {}
      });
    }
  );
}
