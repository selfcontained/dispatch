import type { FastifyInstance } from "fastify";

import {
  CLI_AGENT_TYPES,
  getEnabledAgentTypes,
} from "../../agent-type-settings.js";
import { RENAME_PROMPT } from "../../agents/auto-rename-prompter.js";
import { shouldSuggestSessionRename } from "../../agents/tmux/session-name.js";
import { getAgentDiff, getAgentFileDiff } from "../../shared/git/agent-diff.js";
import {
  AGENT_LATEST_EVENT_TYPES,
  isAgentLatestEventType,
  type AgentRouteDeps,
} from "./shared.js";

export async function registerAgentLifecycleRoutes(
  app: FastifyInstance,
  deps: AgentRouteDeps
): Promise<void> {
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

  app.get("/api/v1/agents/:id/diff", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";

    const agent = await deps.agentManager.getAgent(id);
    if (!agent) {
      return reply.code(404).send({ error: "Agent not found." });
    }

    const gitContextWorktreePath = agent.gitContext?.isWorktree
      ? agent.gitContext.worktreePath
      : null;
    const worktreePath =
      agent.worktreePath ?? gitContextWorktreePath ?? agent.cwd ?? null;
    if (!worktreePath) {
      return reply
        .code(404)
        .send({ error: "Agent has no associated worktree." });
    }

    const baseRef =
      agent.baseBranch ??
      (agent.worktreePath || gitContextWorktreePath ? "main" : null);

    try {
      const ignoreWhitespace =
        (request.query as { ignoreWhitespace?: string }).ignoreWhitespace !==
        "false";
      const result = await getAgentDiff(worktreePath, baseRef, undefined, {
        ignoreWhitespace,
      });
      if (!result) {
        return { baseRef: null, files: [] };
      }
      return result;
    } catch (error) {
      deps.appLog.warn({ err: error, agentId: id }, "Agent diff failed");
      return reply.code(500).send({ error: "Failed to compute diff." });
    }
  });

  app.get("/api/v1/agents/:id/diff/file", async (request, reply) => {
    const params = request.params as { id?: string };
    const query = request.query as { path?: string; force?: string };
    const id = params.id ?? "";

    if (!query.path) {
      return reply.code(400).send({ error: "path query parameter required." });
    }

    if (query.path.includes("..")) {
      return reply.code(400).send({ error: "Invalid file path." });
    }

    const agent = await deps.agentManager.getAgent(id);
    if (!agent) {
      return reply.code(404).send({ error: "Agent not found." });
    }

    const gitContextWorktreePath = agent.gitContext?.isWorktree
      ? agent.gitContext.worktreePath
      : null;
    const worktreePath =
      agent.worktreePath ?? gitContextWorktreePath ?? agent.cwd ?? null;
    if (!worktreePath) {
      return reply
        .code(404)
        .send({ error: "Agent has no associated worktree." });
    }

    const baseRef =
      agent.baseBranch ??
      (agent.worktreePath || gitContextWorktreePath ? "main" : null);

    try {
      const ignoreWhitespace =
        (request.query as { ignoreWhitespace?: string }).ignoreWhitespace !==
        "false";
      const result = await getAgentFileDiff(
        worktreePath,
        baseRef,
        query.path,
        undefined,
        { ignoreWhitespace }
      );
      if (!result) {
        return reply.code(404).send({ error: "File not found in diff." });
      }
      return result;
    } catch (error) {
      deps.appLog.warn(
        { err: error, agentId: id, filePath: query.path },
        "Agent file diff failed"
      );
      return reply.code(500).send({ error: "Failed to compute file diff." });
    }
  });

  app.post("/api/v1/agents/:id/diff/comment", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";

    const body = request.body as {
      filePath?: string;
      startLine?: number;
      endLine?: number;
      comment?: string;
    } | null;

    if (
      !body?.filePath ||
      typeof body.startLine !== "number" ||
      typeof body.endLine !== "number" ||
      !body.comment?.trim()
    ) {
      return reply
        .code(400)
        .send({ error: "filePath, startLine, endLine, and comment required." });
    }

    if (body.filePath.includes("..")) {
      return reply.code(400).send({ error: "Invalid file path." });
    }

    if (
      body.startLine < 1 ||
      body.endLine < body.startLine ||
      !Number.isInteger(body.startLine) ||
      !Number.isInteger(body.endLine)
    ) {
      return reply.code(400).send({ error: "Invalid line range." });
    }

    if (body.endLine - body.startLine > 500) {
      return reply.code(400).send({ error: "Line range too large." });
    }

    if (body.comment.length > 10_000) {
      return reply.code(400).send({ error: "Comment too long." });
    }

    const agent = await deps.agentManager.getAgent(id);
    if (!agent) {
      return reply.code(404).send({ error: "Agent not found." });
    }

    const gitContextWorktreePath = agent.gitContext?.isWorktree
      ? agent.gitContext.worktreePath
      : null;
    const worktreePath =
      agent.worktreePath ?? gitContextWorktreePath ?? agent.cwd ?? null;
    if (!worktreePath) {
      return reply
        .code(404)
        .send({ error: "Agent has no associated worktree." });
    }

    const baseRef =
      agent.baseBranch ??
      (agent.worktreePath || gitContextWorktreePath ? "main" : null);

    let fileDiff;
    try {
      fileDiff = await getAgentFileDiff(worktreePath, baseRef, body.filePath);
    } catch (error) {
      deps.appLog.warn(
        { err: error, agentId: id, filePath: body.filePath },
        "Diff comment: failed to get file diff"
      );
      return reply.code(500).send({ error: "Failed to retrieve diff." });
    }

    if (!fileDiff) {
      return reply.code(404).send({ error: "File not found in diff." });
    }

    const lines = extractNewFileLines(
      fileDiff.diff,
      body.startLine,
      body.endLine
    );

    const lineLabel =
      body.startLine === body.endLine
        ? `Line ${body.startLine}`
        : `Lines ${body.startLine}-${body.endLine}`;
    const codeBlock =
      lines.length > 0
        ? "\n" + lines.map((l) => `│ ${l}`).join("\n") + "\n"
        : "";

    const prompt = [
      "--- DISPATCH: Code Comment ---",
      `File: ${body.filePath}`,
      `${lineLabel}:`,
      codeBlock,
      `Comment: ${body.comment.trim()}`,
      "--- END ---",
    ].join("\n");

    try {
      await deps.sendAgentPrompt(id, prompt);
    } catch (error) {
      deps.appLog.warn(
        { err: error, agentId: id },
        "Diff comment: tmux delivery failed"
      );
      return reply
        .code(500)
        .send({ error: "Failed to deliver comment to agent." });
    }

    return { delivered: true };
  });
}

function extractNewFileLines(
  diffText: string,
  startLine: number,
  endLine: number
): string[] {
  const lines: string[] = [];
  const diffLines = diffText.split("\n");
  let newLineNum = 0;

  for (const line of diffLines) {
    const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunkMatch) {
      newLineNum = parseInt(hunkMatch[1]!, 10) - 1;
      continue;
    }

    if (newLineNum === 0) continue;

    if (line.startsWith("-")) continue;

    if (line.startsWith("+") || line.startsWith(" ")) {
      newLineNum++;
      if (newLineNum >= startLine && newLineNum <= endLine) {
        lines.push(line.slice(1));
      }
      if (newLineNum > endLine) break;
    }
  }

  return lines;
}
