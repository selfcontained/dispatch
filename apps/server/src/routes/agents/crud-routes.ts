import { createReadStream } from "node:fs";
import { access, constants, realpath } from "node:fs/promises";
import path from "node:path";

import type { FastifyInstance } from "fastify";

import {
  AGENT_TYPES,
  type AgentType,
  getEnabledAgentTypes,
} from "../../agent-type-settings.js";
import { getWorktreeLocation } from "../../worktree-location-settings.js";
import {
  type CreateAgentBody,
  type StartupFileUpload,
  MAX_STARTUP_FILE_COUNT,
  createStartupPins,
  parseCreateAgentRequest,
  parseOptionalBooleanField,
  parseOptionalStringArrayField,
} from "../agent-startup.js";
import { errorMessage } from "../../shared/lib/error-message.js";
import {
  AGENT_INITIAL_PROMPT_MAX_CHARS,
  CODEX_FULL_ACCESS_ARG,
  CLAUDE_FULL_ACCESS_ARG,
  type AgentRouteDeps,
} from "./shared.js";
import { validateAgentModel } from "../../shared/agent-models.js";

export async function registerAgentCrudRoutes(
  app: FastifyInstance,
  deps: AgentRouteDeps
): Promise<void> {
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
        error: errorMessage(error),
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
        error: errorMessage(error),
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

    if (body.model !== undefined && typeof body.model !== "string") {
      return reply
        .code(400)
        .send({ error: "model must be a string when provided." });
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
    let model: string | undefined;
    try {
      model = validateAgentModel(
        agentType,
        typeof body.model === "string" ? body.model : undefined
      );
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
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
        error: errorMessage(error),
      });
    }

    try {
      const worktreeLocation = await getWorktreeLocation(deps.pool);

      const agent = await deps.agentManager.createAgent({
        name: typeof body.name === "string" ? body.name : undefined,
        type: agentType,
        cwd: body.cwd,
        agentArgs: resolvedAgentArgs,
        model,
        fullAccess: !isTerminalAgent && fullAccess === true,
        useWorktree,
        createNewBranch,
        worktreeBranch:
          typeof body.worktreeBranch === "string"
            ? body.worktreeBranch
            : undefined,
        baseBranch:
          typeof body.baseBranch === "string" ? body.baseBranch : undefined,
        worktreeLocation,
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
        launchContext: {
          prompt:
            !isTerminalAgent && typeof body.initialPrompt === "string"
              ? body.initialPrompt.trim() || undefined
              : undefined,
          links: !isTerminalAgent ? (startupLinks ?? []) : [],
        },
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
}
