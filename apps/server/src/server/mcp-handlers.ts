import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";

import type {
  AgentManager,
  AgentRecord,
  FeedbackInput,
  FeedbackRecord,
} from "../agents/manager.js";
import {
  CLI_AGENT_TYPES,
  getEnabledAgentTypes,
} from "../agent-type-settings.js";
import { isCrossRepoMessagingEnabled } from "../cross-repo-messaging-settings.js";
import type { JobService } from "../jobs/service.js";
import type {
  NotifyInput,
  NotifyResult,
  SlackNotifier,
} from "../notifications/slack.js";
import { isPinType, validatePinValue } from "../pins.js";
import { resolveRepoRoot } from "../shared/git/git-context.js";
import { resolveHeadSha } from "../shared/git/worktree.js";
import { isMediaFile, isTextFile, resolveMediaDir } from "../shared/media.js";
import type { PublishUiEvent, SendAgentPrompt } from "./mcp-handler-types.js";
import { createReviewHandlers } from "./mcp-review-handlers.js";

const AGENT_LATEST_EVENT_TYPES = [
  "working",
  "blocked",
  "waiting_user",
  "done",
  "idle",
] as const;

function buildChildAgentInitialPrompt(
  parentAgentId: string,
  prompt: string
): string {
  return [
    `You were launched by Dispatch agent "${parentAgentId}" via dispatch_launch_agent.`,
    "Use that parent agent ID when coordinating back with dispatch_send_message.",
    "",
    prompt,
  ].join("\n");
}

type AgentLatestEventType = (typeof AGENT_LATEST_EVENT_TYPES)[number];

type CreateMcpHandlersDeps = {
  pool: Pool;
  mediaRoot: string;
  agentManager: AgentManager;
  jobService: JobService;
  slackNotifier: SlackNotifier;
  publishUiEvent: PublishUiEvent;
  withStreamFlag: <T extends AgentRecord>(
    agent: T
  ) => T & { hasStream: boolean };
  sendAgentPrompt: SendAgentPrompt;
  appLog: FastifyBaseLogger;
};

function isAgentLatestEventType(value: unknown): value is AgentLatestEventType {
  return (
    typeof value === "string" &&
    AGENT_LATEST_EVENT_TYPES.includes(value as AgentLatestEventType)
  );
}

export function mcpMethodNotAllowed(): {
  jsonrpc: "2.0";
  error: { code: number; message: string };
  id: null;
} {
  return {
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed.",
    },
    id: null,
  };
}

/**
 * The set of agents a sender may address via dispatch_send_message and
 * list_agents: every other agent (self excluded), scoped to the sender's git
 * repo root unless cross-repo messaging is enabled. Direct parent ↔ child
 * relationships always bypass repo-root scoping so spawned agents can
 * coordinate with their parent regardless of working directory. This is the
 * single definition of that visibility boundary — both message delivery and
 * agent listing consult it, so they can never disagree about who is reachable.
 */
async function addressableAgents<
  T extends { id: string; cwd: string; parentAgentId?: string | null },
>(
  all: T[],
  agentId: string,
  senderRepoRoot: string | null,
  crossRepo: boolean
): Promise<T[]> {
  const sender = all.find((a) => a.id === agentId);
  const senderParentId = sender?.parentAgentId ?? null;

  const result: T[] = [];
  for (const a of all) {
    if (a.id === agentId) continue;
    if (crossRepo) {
      result.push(a);
      continue;
    }
    // Direct parent ↔ child always visible. parentAgentId is trusted because
    // MCP-originated creation sets it server-side; the HTTP path is localhost-only.
    if (a.id === senderParentId || a.parentAgentId === agentId) {
      result.push(a);
      continue;
    }
    try {
      const aRoot = await resolveRepoRoot(a.cwd);
      if (aRoot === senderRepoRoot) result.push(a);
    } catch {
      // agent cwd not in a git repo — skip
    }
  }
  return result;
}

export function createMcpHandlers(deps: CreateMcpHandlersDeps) {
  const {
    pool,
    mediaRoot,
    agentManager,
    jobService,
    slackNotifier,
    publishUiEvent,
    withStreamFlag,
    sendAgentPrompt,
    appLog,
  } = deps;

  const reviewHandlers = createReviewHandlers({
    pool,
    agentManager,
    publishUiEvent,
    withStreamFlag,
    sendAgentPrompt,
  });

  return {
    ...reviewHandlers,

    async upsertEvent(
      agentId: string,
      event: {
        type: string;
        message: string;
        metadata?: Record<string, unknown>;
      }
    ): Promise<void> {
      if (!isAgentLatestEventType(event.type)) {
        throw new Error(
          `type must be one of: ${AGENT_LATEST_EVENT_TYPES.join(", ")}.`
        );
      }
      const agent = await agentManager.upsertLatestEvent(agentId, {
        type: event.type,
        message: event.message.trim(),
        metadata: event.metadata,
      });
      publishUiEvent({ type: "agent.upsert", agent: withStreamFlag(agent) });
    },

    async sendNotify(
      agentId: string,
      input: NotifyInput
    ): Promise<NotifyResult> {
      const agent = await agentManager.getAgent(agentId);
      if (!agent) throw new Error("Agent not found.");
      return slackNotifier.sendNotification(agent, input);
    },

    async submitFeedback(
      agentId: string,
      feedback: FeedbackInput
    ): Promise<FeedbackRecord> {
      const record = await agentManager.submitFeedback(agentId, feedback);
      publishUiEvent({
        type: "feedback.created",
        agentId,
        feedback: record,
      });
      return record;
    },

    async getFeedback(
      agentId: string,
      opts: { persona?: string; limit?: number }
    ) {
      return agentManager.listFeedbackByParentGrouped(
        agentId,
        opts.persona,
        opts.limit
      );
    },

    async resolveFeedback(
      agentId: string,
      feedbackId: number,
      status: "fixed" | "ignored",
      options: { reason?: string | null } = {}
    ): Promise<FeedbackRecord> {
      const parent = await agentManager.getAgent(agentId);
      const resolutionCommit = parent ? await resolveHeadSha(parent.cwd) : null;
      const record = await agentManager.updateFeedbackStatusByParent(
        feedbackId,
        agentId,
        status,
        { reason: options.reason ?? null, resolutionCommit }
      );
      if (!record) {
        throw new Error(
          `Feedback #${feedbackId} not found or not owned by a child of this agent.`
        );
      }
      publishUiEvent({
        type: "feedback.updated",
        agentId: record.agentId,
        feedback: record,
      });
      return record;
    },

    async upsertPin(
      agentId: string,
      pin: { label: string; value: string; type: string }
    ): Promise<void> {
      if (!isPinType(pin.type)) {
        throw new Error(`Invalid pin type: ${pin.type}`);
      }
      validatePinValue(pin.type, pin.value);
      const agent = await agentManager.upsertPin(agentId, {
        label: pin.label,
        value: pin.value,
        type: pin.type,
      });
      publishUiEvent({ type: "agent.upsert", agent: withStreamFlag(agent) });
    },

    async deletePin(agentId: string, label: string): Promise<void> {
      const agent = await agentManager.deletePin(agentId, label);
      publishUiEvent({ type: "agent.upsert", agent: withStreamFlag(agent) });
    },

    async renameSession(
      agentId: string,
      name: string
    ): Promise<{ id: string; name: string }> {
      const agent = await agentManager.renameAgent(agentId, name);
      publishUiEvent({ type: "agent.upsert", agent: withStreamFlag(agent) });
      return { id: agent.id, name: agent.name };
    },

    async jobComplete(
      agentId: string,
      report: unknown
    ): Promise<{ runId: string; status: string }> {
      const run = await jobService.completeRunForAgent(agentId, report);
      return { runId: run.id, status: run.status };
    },

    async jobFailed(
      agentId: string,
      report: unknown
    ): Promise<{ runId: string; status: string }> {
      const run = await jobService.failRunForAgent(agentId, report);
      return { runId: run.id, status: run.status };
    },

    async jobNeedsInput(
      agentId: string,
      question: string
    ): Promise<{ runId: string; status: string }> {
      const run = await jobService.markNeedsInputForAgent(agentId, question);
      return { runId: run.id, status: run.status };
    },

    async jobLog(
      agentId: string,
      input: {
        task: string;
        message: string;
        level: "debug" | "info" | "warn" | "error";
      }
    ): Promise<{ runId: string; status: string }> {
      const run = await jobService.logForAgent(agentId, input);
      return { runId: run.id, status: run.status };
    },

    async launchAgent(
      agentId: string,
      input: {
        name: string;
        prompt: string;
        type?: string;
        useWorktree?: boolean;
        createNewBranch?: boolean;
        baseBranch?: string;
        worktreeBranch?: string;
        fullAccess?: boolean;
        templateId?: string;
        cwd?: string;
      }
    ): Promise<{ agentId: string; name: string }> {
      const parent = await agentManager.getAgent(agentId);
      if (!parent) throw new Error("Parent agent not found.");

      const agentType = input.type ?? parent.type ?? "claude";
      if (
        !CLI_AGENT_TYPES.includes(agentType as (typeof CLI_AGENT_TYPES)[number])
      ) {
        throw new Error(
          `Unsupported agent type "${agentType}". Must be one of: ${CLI_AGENT_TYPES.join(", ")}.`
        );
      }

      const enabledAgentTypes = await getEnabledAgentTypes(pool);
      if (
        !enabledAgentTypes.includes(
          agentType as (typeof CLI_AGENT_TYPES)[number]
        )
      ) {
        throw new Error(`${agentType} agents are disabled in settings.`);
      }

      const parentCwd = parent.worktreePath ?? parent.cwd;
      const useWorktree = input.useWorktree ?? false;
      const createNewBranch = input.createNewBranch ?? false;
      const fullAccess = parent.fullAccess && input.fullAccess !== false;

      const cliSessionId = agentType === "claude" ? randomUUID() : undefined;

      const agent = await agentManager.createAgent({
        name: input.name,
        type: agentType as (typeof CLI_AGENT_TYPES)[number],
        cwd: input.cwd ?? parentCwd,
        fullAccess,
        useWorktree,
        createNewBranch,
        baseBranch: input.baseBranch,
        worktreeBranch: input.worktreeBranch,
        parentAgentId: agentId,
        cliSessionId,
        initialPrompt: buildChildAgentInitialPrompt(agentId, input.prompt),
        templateId: input.templateId,
      });

      publishUiEvent({
        type: "agent.upsert",
        agent: withStreamFlag(agent),
      });

      return { agentId: agent.id, name: agent.name };
    },

    async shareMedia(
      agentId: string,
      opts: {
        filePath: string;
        description: string;
        source?: string;
        name?: string;
        update?: string;
      }
    ): Promise<{
      fileName: string;
      url: string;
      sizeBytes: number;
      source: string;
      description: string;
    }> {
      const agent = await agentManager.getAgent(agentId);
      if (!agent) throw new Error("Agent not found.");

      if (!isMediaFile(opts.filePath)) {
        throw new Error(
          "Unsupported file type. Use images (png/jpg/gif/webp), video (mp4), documents (pdf), or text files (txt/md/json/yaml/ts/py/etc)."
        );
      }

      const isText = isTextFile(opts.filePath);
      const validSources = ["screenshot", "stream", "simulator", "text"];
      const source = isText
        ? "text"
        : opts.source && validSources.includes(opts.source)
          ? opts.source
          : "screenshot";

      const buffer = await readFile(opts.filePath);
      const mediaDir = resolveMediaDir(agentId, agent.mediaDir, mediaRoot);
      await mkdir(mediaDir, { recursive: true });

      if (opts.update) {
        const existing = await pool.query<{ file_name: string }>(
          `SELECT file_name FROM media WHERE agent_id = $1 AND file_name = $2 FOR UPDATE`,
          [agentId, opts.update]
        );
        if (existing.rows.length === 0) {
          throw new Error(
            "No media file found with the given fileName for this agent."
          );
        }

        const fileName = existing.rows[0].file_name;
        const filePath = path.join(mediaDir, fileName);
        const resolvedMediaDir = path.resolve(mediaDir);
        if (!path.resolve(filePath).startsWith(resolvedMediaDir + path.sep)) {
          throw new Error("Invalid media file path.");
        }

        await writeFile(filePath, buffer);
        await pool.query(
          `UPDATE media SET size_bytes = $1, description = $2, updated_at = NOW()
           WHERE agent_id = $3 AND file_name = $4`,
          [buffer.length, opts.description, agentId, fileName]
        );

        publishUiEvent({ type: "media.changed", agentId });
        return {
          fileName,
          url: `/api/v1/agents/${agentId}/media/${encodeURIComponent(fileName)}`,
          sizeBytes: buffer.length,
          source,
          description: opts.description,
        };
      }

      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .replace("T", "-")
        .replace("Z", "");
      const baseName = opts.name ?? path.basename(opts.filePath);
      const ext0 = path.extname(baseName).toLowerCase();
      const fallbackExt =
        ext0 === ".mp4" ? ".mp4" : isText ? ext0 || ".txt" : ".png";
      const safeName =
        baseName.replace(/ /g, "-").replace(/[^A-Za-z0-9._-]/g, "") ||
        `shared-${timestamp}${fallbackExt}`;
      const ext = path.extname(safeName);
      const base = path.basename(safeName, ext);
      const fileName = `${base}-${timestamp}${ext}`;

      await writeFile(path.join(mediaDir, fileName), buffer);
      await pool.query(
        `INSERT INTO media (agent_id, file_name, source, size_bytes, description)
         VALUES ($1, $2, $3, $4, $5)`,
        [agentId, fileName, source, buffer.length, opts.description]
      );

      publishUiEvent({ type: "media.changed", agentId });
      return {
        fileName,
        url: `/api/v1/agents/${agentId}/media/${encodeURIComponent(fileName)}`,
        sizeBytes: buffer.length,
        source,
        description: opts.description,
      };
    },

    async sendMessage(
      agentId: string,
      input: { target: string; message: string; senderRepoRoot: string | null }
    ): Promise<{
      delivered: boolean;
      targetAgentId: string;
      targetAgentName: string;
    }> {
      const sender = await agentManager.getAgent(agentId);
      if (!sender) throw new Error("Sender agent not found.");

      const senderRepoRoot = input.senderRepoRoot;
      const crossRepo = await isCrossRepoMessagingEnabled(pool);

      const allAgents = await addressableAgents(
        await agentManager.listAgents(),
        agentId,
        senderRepoRoot,
        crossRepo
      );

      const isAgentId = input.target.startsWith("agt_");

      let target: (typeof allAgents)[number] | undefined;
      if (isAgentId) {
        target = allAgents.find((a) => a.id === input.target);
      } else {
        const lowerTarget = input.target.toLowerCase();
        const matches = allAgents.filter(
          (a) =>
            a.status === "running" && a.name.toLowerCase().includes(lowerTarget)
        );
        if (matches.length === 1) {
          target = matches[0];
        } else if (matches.length > 1) {
          const list = matches.map((a) => `  ${a.id} "${a.name}"`).join("\n");
          throw new Error(
            `Multiple agents match "${input.target}". Use the agent ID:\n${list}`
          );
        }
      }

      if (!target) {
        const running = allAgents
          .filter((a) => a.status === "running")
          .map((a) => `  ${a.id} "${a.name}"`)
          .join("\n");
        throw new Error(
          `No agent found matching "${input.target}".${running ? ` Running agents:\n${running}` : " No other agents are running."}`
        );
      }

      if (target.status !== "running") {
        throw new Error(
          `Agent "${target.name}" (${target.id}) is ${target.status}, not running.`
        );
      }

      const envelope = JSON.stringify({
        from: sender.name,
        senderId: agentId,
        message: input.message,
        replyTarget: agentId,
      });
      const prompt = `--- DISPATCH MESSAGE ---\n${envelope}\n--- END MESSAGE ---\nReply with dispatch_send_message using the replyTarget above.`;

      try {
        await sendAgentPrompt(target.id, prompt, { swallowFailure: false });
      } catch (err) {
        appLog.error(
          { err, senderId: agentId, targetId: target.id },
          "dispatch_send_message: tmux delivery failed"
        );
        throw err;
      }

      appLog.info(
        { senderId: agentId, targetId: target.id },
        "dispatch_send_message: delivered"
      );
      return {
        delivered: true,
        targetAgentId: target.id,
        targetAgentName: target.name,
      };
    },

    async listAgentsForAgent(
      agentId: string,
      senderRepoRoot: string | null
    ): Promise<
      Array<{
        id: string;
        name: string;
        status: string;
        latestEvent: { type: string; message: string } | null;
      }>
    > {
      const crossRepo = await isCrossRepoMessagingEnabled(pool);

      const agents = await addressableAgents(
        await agentManager.listAgents(),
        agentId,
        senderRepoRoot,
        crossRepo
      );
      const result: Array<{
        id: string;
        name: string;
        status: string;
        latestEvent: { type: string; message: string } | null;
      }> = [];
      for (const a of agents) {
        result.push({
          id: a.id,
          name: a.name,
          status: a.status,
          latestEvent: a.latestEvent
            ? { type: a.latestEvent.type, message: a.latestEvent.message }
            : null,
        });
      }
      return result;
    },

    async listMedia(
      agentId: string,
      opts: { source?: string }
    ): Promise<
      Array<{
        fileName: string;
        filePath: string;
        source: string;
        description: string | null;
        sizeBytes: number;
        createdAt: string;
      }>
    > {
      const agent = await agentManager.getAgent(agentId);
      if (!agent) throw new Error("Agent not found.");

      const mediaDir = resolveMediaDir(agentId, agent.mediaDir, mediaRoot);
      const whereClause = opts.source
        ? `WHERE agent_id = $1 AND source = $2`
        : `WHERE agent_id = $1`;
      const params: (string | number)[] = opts.source
        ? [agentId, opts.source]
        : [agentId];

      const result = await pool.query<{
        file_name: string;
        source: string;
        description: string | null;
        size_bytes: number;
        created_at: Date;
      }>(
        `SELECT file_name, source, description, size_bytes, created_at
         FROM media ${whereClause}
         ORDER BY created_at DESC LIMIT 100`,
        params
      );

      return result.rows.map((row) => ({
        fileName: row.file_name,
        filePath: path.join(mediaDir, row.file_name),
        source: row.source,
        description: row.description ?? null,
        sizeBytes: row.size_bytes,
        createdAt: row.created_at.toISOString(),
      }));
    },
  };
}
