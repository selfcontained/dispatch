import type { FastifyInstance } from "fastify";

import {
  CLI_AGENT_TYPES,
  getEnabledAgentTypes,
} from "../../agent-type-settings.js";
import { shouldSuggestSessionRename } from "../../agents/launch-guidance.js";
import { StreamServiceError } from "../../chat/service.js";
import { getAgentDiff, getAgentFileDiff } from "../../shared/git/agent-diff.js";
import { getAgentDiffImage, isImageFile } from "../../shared/git/diff-image.js";
import { getDiffStats } from "../../shared/git/diff-stats.js";
import type { AgentRouteDeps } from "./shared.js";

/**
 * What the sidebar's "name this session" button sends. Dispatch no longer
 * nudges on its own — the launch guidance already asks for a name, and
 * saying it twice cost a turn and a line in the stream — so this is only
 * ever sent because someone asked for it.
 */
const RENAME_PROMPT =
  "Please call the `rename_session` MCP tool with a short, descriptive name for this session's topic. If the session already has a meaningful name, keep it. This request is only to name the session; it does not ask you to start or resume other work.";

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

  app.post("/api/v1/agents/:id/runtime/cancel", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";
    try {
      await deps.agentManager.getTerminalAccess(id);
      await deps.agentManager.cancelTurn(id);
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

  app.patch("/api/v1/agents/:id/name", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";
    const body = request.body as { name?: unknown } | null;

    if (typeof body?.name !== "string" || !body.name.trim()) {
      return reply
        .code(400)
        .send({ error: "name must be a non-empty string." });
    }
    if (body.name.length > 120) {
      return reply
        .code(400)
        .send({ error: "name must be 120 characters or fewer." });
    }

    try {
      const agent = await deps.agentManager.renameAgent(id, body.name);
      deps.publishUiEvent({
        type: "agent.upsert",
        agent: deps.withStreamFlag(agent),
      });
      return { agent: deps.withStreamFlag(agent) };
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
      // Mirror the gates the launch guidance and the sidebar UI apply, so a
      // direct API caller can't paste the rename prompt into an agent that
      // wouldn't be eligible via the UI: personas / job agents / already-
      // renamed agents already carry a meaningful name.
      if (
        !shouldSuggestSessionRename(agent.name, agent.id, {
          persona: agent.persona,
        })
      ) {
        return reply
          .code(409)
          .send({ error: "Agent already has a custom session name." });
      }
      const posted = await deps.chat.sendUserPost(
        await deps.chat.streamOf(id),
        {
          to: id,
          text: RENAME_PROMPT,
          allowInert: false,
        }
      );
      return reply.code(202).send(posted);
    } catch (error) {
      if (error instanceof StreamServiceError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
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

    const includeUncommitted =
      (request.query as { includeUncommitted?: string }).includeUncommitted !==
      "false";

    if (!includeUncommitted) {
      const gitContextWorktreePath = agent.gitContext?.isWorktree
        ? agent.gitContext.worktreePath
        : null;
      const worktreePath =
        agent.worktreePath ?? gitContextWorktreePath ?? agent.cwd ?? null;
      if (!worktreePath) return { diffStats: null };

      const baseRef =
        agent.baseBranch ??
        (agent.worktreePath || gitContextWorktreePath ? "main" : null);
      return {
        diffStats: await getDiffStats(worktreePath, baseRef, {
          includeUncommitted: false,
        }),
      };
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
      const query = request.query as {
        ignoreWhitespace?: string;
        includeUncommitted?: string;
      };
      const ignoreWhitespace = query.ignoreWhitespace !== "false";
      const includeUncommitted = query.includeUncommitted !== "false";
      const result = await getAgentDiff(worktreePath, baseRef, undefined, {
        ignoreWhitespace,
        includeUncommitted,
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
    const query = request.query as {
      path?: string;
      force?: string;
      ignoreWhitespace?: string;
      includeUncommitted?: string;
    };
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
      const ignoreWhitespace = query.ignoreWhitespace !== "false";
      const includeUncommitted = query.includeUncommitted !== "false";
      const result = await getAgentFileDiff(
        worktreePath,
        baseRef,
        query.path,
        undefined,
        { ignoreWhitespace, includeUncommitted }
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

  app.get("/api/v1/agents/:id/diff/image", async (request, reply) => {
    const params = request.params as { id?: string };
    const query = request.query as {
      path?: string;
      side?: string;
      includeUncommitted?: string;
    };
    const id = params.id ?? "";

    if (!query.path) {
      return reply.code(400).send({ error: "path query parameter required." });
    }
    // The path is a caller-supplied string that becomes both a git pathspec
    // and (for the new side) a filesystem read, so it is checked here and
    // re-anchored inside the worktree by readImageSide.
    if (query.path.startsWith("/") || query.path.split("/").includes("..")) {
      return reply.code(400).send({ error: "Invalid file path." });
    }
    if (!isImageFile(query.path)) {
      return reply.code(400).send({ error: "Not a previewable image." });
    }
    const side = query.side === "old" ? "old" : "new";

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
    const includeUncommitted = query.includeUncommitted !== "false";

    try {
      const result = await getAgentDiffImage(
        worktreePath,
        baseRef,
        query.path,
        side,
        { includeUncommitted }
      );
      if (!result.ok) {
        return reply
          .code(result.reason === "too-large" ? 413 : 404)
          .send({ error: "Image not available." });
      }

      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("Cache-Control", "private, max-age=30");
      return reply.type(result.contentType).send(result.buffer);
    } catch (error) {
      deps.appLog.warn(
        { err: error, agentId: id, filePath: query.path },
        "Agent diff image failed"
      );
      return reply.code(500).send({ error: "Failed to read image." });
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
      lines.length > 0 ? ["```", ...lines, "```"].join("\n") : "";

    // The comment is a post in the agent's stream, like anything else a
    // person says to it: it reads in the Chat and reaches the agent as a
    // prompt, quoting the lines it is about.
    const text = [
      `**${body.filePath}** · ${lineLabel}`,
      codeBlock,
      body.comment.trim(),
    ]
      .filter(Boolean)
      .join("\n\n");

    try {
      const streamId = await deps.chat.streamOf(id);
      const posted = await deps.chat.sendUserPost(streamId, {
        to: id,
        text,
        allowInert: false,
      });
      return { delivered: true, block: posted.block };
    } catch (error) {
      deps.appLog.warn(
        { err: error, agentId: id },
        "Diff comment: delivery failed"
      );
      return reply
        .code(500)
        .send({ error: "Failed to deliver comment to agent." });
    }
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
