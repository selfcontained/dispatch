import path from "node:path";

import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { SharedUiEvent } from "@dispatch/shared";

import type { AgentManager } from "../agents/manager.js";
import * as telemetry from "../agents/telemetry.js";
import type { LoginLinkStore } from "../auth.js";
import type { BrainStore } from "../brain/store.js";
import type { AddJobInput, JobService } from "../jobs/service.js";
import type {
  TemplateService,
  AddTemplateInput,
} from "../templates/service.js";
import {
  resolveRepoRoot,
  resolveWorktreeRoot,
} from "../shared/git/git-context.js";
import type { CrudToolCallbacks } from "../shared/mcp/crud-tools.js";
import { handleMcpRequest } from "../shared/mcp/server.js";
import type { SurfaceService } from "../surfaces/service.js";
import type { ChatService } from "../chat/service.js";

/**
 * Resolves once the response has left the server — `finish` when it was
 * written, `close` when the socket went away first. Attached before the MCP
 * transport writes anything so no event can be missed.
 */
function onceResponseFinished(res: {
  writableEnded?: boolean;
  once(event: string, listener: () => void): unknown;
}): Promise<void> {
  if (res.writableEnded) return Promise.resolve();
  return new Promise<void>((resolve) => {
    res.once("finish", () => resolve());
    res.once("close", () => resolve());
  });
}

type McpRouteDeps = {
  config: {
    authToken: string;
  };
  pool: Pool;
  loginLinkStore: LoginLinkStore;
  agentManager: AgentManager;
  jobService: JobService;
  templateService: TemplateService;
  brainStore: BrainStore;
  publishBrainChanged: (repoRoot: string) => void;
  /** Fans `agent.tool_invoked` out to the SSE stream (presence strip). */
  publishUiEvent: (event: SharedUiEvent) => void;
  getBearerToken: (request: {
    headers: { authorization?: string };
  }) => string | null;
  validateJobMcpToken: (
    authToken: string,
    bearerToken: string,
    runId: string,
    agentId: string
  ) => boolean;
  validateAgentMcpToken: (
    authToken: string,
    bearerToken: string,
    agentId: string
  ) => boolean;
  mcpSendNotify: unknown;
  mcpUpsertEvent: unknown;
  mcpRenameSession: unknown;
  mcpShareMedia: unknown;
  mcpListMedia: unknown;
  mcpDeleteMedia: unknown;
  mcpListPins: unknown;
  mcpGetWhiteboard: unknown;
  mcpUpdateWhiteboard: unknown;
  mcpClearWhiteboard: unknown;
  mcpListPersonas: unknown;
  mcpLaunchPersona: unknown;
  mcpListPersonalities: unknown;
  mcpCreatePersonality: unknown;
  mcpUpdatePersonality: unknown;
  mcpDeletePersonality: unknown;
  mcpSetActivePersonality: unknown;
  mcpClearActivePersonality: unknown;
  mcpLaunchAgent: unknown;
  mcpArchiveAgent: unknown;
  mcpResolveReviewFeedback: unknown;
  mcpReopenReviewFeedback: unknown;
  mcpSubmitReview: unknown;
  mcpAddReviewFeedback: unknown;
  mcpAddReviewThreadMessage: unknown;
  mcpListReviewFeedback: unknown;
  mcpGetReviewFeedbackItem: unknown;
  mcpUpsertPin: unknown;
  mcpUpsertPins: unknown;
  mcpDeletePin: unknown;
  mcpDeletePinByLabel: unknown;
  mcpJobComplete: unknown;
  mcpJobFailed: unknown;
  mcpJobNeedsInput: unknown;
  mcpJobLog: unknown;
  mcpSendMessage: unknown;
  mcpListAgentsForAgent: unknown;
  mcpMethodNotAllowed: () => unknown;
  surfaces: SurfaceService;
  chat: Pick<ChatService, "post" | "update">;
};

function buildCrudCallbacks(deps: McpRouteDeps): CrudToolCallbacks {
  return {
    listJobs: async (directory) => {
      const jobs = await deps.jobService.listJobs();
      if (!directory) return jobs;
      const resolved = path.resolve(directory);
      return jobs.filter((j) => j.directory === resolved);
    },
    getJobById: (jobId) => deps.jobService.getJobById(jobId),
    getJobByName: (directory, name) =>
      deps.jobService.getJobByName(directory, name),
    createJob: (input) => deps.jobService.addJob(input as AddJobInput),
    updateJob: (input) => deps.jobService.updateJob(input as AddJobInput),
    deleteJob: (name, directory) =>
      deps.jobService.removeJob({ name, directory }),
    runJob: (name, directory) =>
      deps.jobService.runJob({ name, directory, wait: false }),
    listTemplates: async (directory) => {
      const templates = await deps.templateService.listTemplates();
      if (!directory) return templates;
      const resolved = path.resolve(directory);
      return templates.filter((t) => t.directory === resolved);
    },
    getTemplateById: (templateId) =>
      deps.templateService.getTemplate(templateId),
    getTemplateByName: (directory, name) =>
      deps.templateService.getTemplateByName(directory, name),
    createTemplate: (input) =>
      deps.templateService.addTemplate(input as AddTemplateInput),
    updateTemplate: (templateId, input) =>
      deps.templateService.updateTemplate(
        templateId,
        input as Partial<AddTemplateInput>
      ),
    deleteTemplate: (templateId) =>
      deps.templateService.removeTemplate(templateId),
  };
}

export async function registerMcpRoutes(
  app: FastifyInstance,
  deps: McpRouteDeps
): Promise<void> {
  app.post("/api/mcp", async (request, reply) => {
    reply.hijack();
    await handleMcpRequest(request.raw, reply.raw, request.body);
  });

  app.post("/api/mcp/jobs/:runId/:agentId", async (request, reply) => {
    const params = request.params as { runId?: string; agentId?: string };
    const runId = params.runId ?? "";
    const agentId = params.agentId ?? "";
    const bearerToken = deps.getBearerToken(request);
    if (
      bearerToken &&
      !deps.validateJobMcpToken(
        deps.config.authToken,
        bearerToken,
        runId,
        agentId
      )
    ) {
      return reply.code(403).send({
        error: "Invalid MCP token for the requested job agent route.",
      });
    }

    const agent = await deps.agentManager.getAgent(agentId);
    if (!agent) {
      return reply.code(404).send({ error: "Agent not found." });
    }

    const run = await deps.jobService.getActiveRunForAgent(agentId);
    if (run && run.id !== runId) {
      return reply
        .code(403)
        .send({ error: "Token does not match the active job run." });
    }

    let repoRoot: string | null = null;
    let worktreeRoot: string | null = null;
    try {
      repoRoot = await resolveRepoRoot(agent.cwd);
      worktreeRoot = await resolveWorktreeRoot(agent.cwd);
    } catch {}

    const jobTools = run
      ? {
          complete: deps.mcpJobComplete,
          failed: deps.mcpJobFailed,
          needsInput: deps.mcpJobNeedsInput,
          log: deps.mcpJobLog,
          listAgents: async () => {
            const agents = await deps.agentManager.listAgents();
            return agents.map((a) => ({
              id: a.id,
              name: a.name,
              status: a.status,
              cwd: a.cwd,
            }));
          },
          getActivitySummary: (params: Record<string, unknown>) =>
            telemetry.getActivitySummary(deps.pool, params as never),
          getFeedbackSummary: (params: Record<string, unknown>) =>
            telemetry.getFeedbackSummary(deps.pool, params as never),
        }
      : undefined;

    reply.hijack();
    // Captured before the transport writes anything, so an archive that stops
    // the calling session can wait for its own response to be delivered.
    const responseFinished = onceResponseFinished(reply.raw);
    await handleMcpRequest(request.raw, reply.raw, request.body, {
      whenResponseFinished: () => responseFinished,
      agent: {
        id: agent.id,
        cwd: agent.cwd,
        type: agent.type,
        role: agent.role,
        persona: agent.persona,
        parentAgentId: agent.parentAgentId,
        baseBranch: agent.baseBranch,
      },
      repoRoot,
      worktreeRoot,
      sendNotify: deps.mcpSendNotify,
      upsertEvent: deps.mcpUpsertEvent,
      renameSession: deps.mcpRenameSession,
      shareMedia: deps.mcpShareMedia,
      listMedia: deps.mcpListMedia,
      deleteMedia: deps.mcpDeleteMedia,
      getWhiteboard: deps.mcpGetWhiteboard,
      updateWhiteboard: deps.mcpUpdateWhiteboard,
      clearWhiteboard: deps.mcpClearWhiteboard,
      upsertPin: deps.mcpUpsertPin,
      upsertPins: deps.mcpUpsertPins,
      deletePin: deps.mcpDeletePin,
      deletePinByLabel: deps.mcpDeletePinByLabel,
      listPins: deps.mcpListPins,
      listPersonas: deps.mcpListPersonas,
      launchPersona: deps.mcpLaunchPersona,
      listPersonalities: deps.mcpListPersonalities,
      createPersonality: deps.mcpCreatePersonality,
      updatePersonality: deps.mcpUpdatePersonality,
      deletePersonality: deps.mcpDeletePersonality,
      setActivePersonality: deps.mcpSetActivePersonality,
      clearActivePersonality: deps.mcpClearActivePersonality,
      launchAgent: deps.mcpLaunchAgent,
      archiveAgent: deps.mcpArchiveAgent,
      resolveReviewFeedback: deps.mcpResolveReviewFeedback,
      reopenReviewFeedback: deps.mcpReopenReviewFeedback,
      submitReview: deps.mcpSubmitReview,
      addReviewFeedback: deps.mcpAddReviewFeedback,
      addReviewThreadMessage: deps.mcpAddReviewThreadMessage,
      listReviewFeedback: deps.mcpListReviewFeedback,
      getReviewFeedbackItem: deps.mcpGetReviewFeedbackItem,
      sendMessage: deps.mcpSendMessage,
      listAgentsForAgent: deps.mcpListAgentsForAgent,
      getActivitySummary: (params: Record<string, unknown>) =>
        telemetry.getActivitySummary(deps.pool, params as never) as Promise<
          Record<string, unknown>
        >,
      getFeedbackSummary: (params: Record<string, unknown>) =>
        telemetry.getFeedbackSummary(deps.pool, params as never) as Promise<
          Record<string, unknown>
        >,
      toolScope: run ? "job" : "agent",
      jobTools,
      crudTools: buildCrudCallbacks(deps),
      brainStore: deps.brainStore,
      publishBrainChanged: deps.publishBrainChanged,
      publishUiEvent: deps.publishUiEvent,
      surfaces: deps.surfaces,
      chat: deps.chat,
    } as Parameters<typeof handleMcpRequest>[3]);
  });

  app.post("/api/mcp/:agentId", async (request, reply) => {
    const params = request.params as { agentId?: string };
    const agentId = params.agentId ?? "";
    const bearerToken = deps.getBearerToken(request);
    if (
      bearerToken &&
      !deps.validateAgentMcpToken(deps.config.authToken, bearerToken, agentId)
    ) {
      return reply
        .code(403)
        .send({ error: "Invalid MCP token for the requested agent route." });
    }

    const agent = await deps.agentManager.getAgent(agentId);
    if (!agent) {
      return reply.code(404).send({ error: "Agent not found." });
    }

    const activeJobRun = await deps.jobService.getActiveRunForAgent(agentId);
    if (activeJobRun) {
      return reply
        .code(403)
        .send({ error: "Job agents must use the job-scoped MCP route." });
    }

    let repoRoot: string | null = null;
    let worktreeRoot: string | null = null;
    try {
      repoRoot = await resolveRepoRoot(agent.cwd);
      worktreeRoot = await resolveWorktreeRoot(agent.cwd);
    } catch {}

    reply.hijack();
    // Captured before the transport writes anything, so an archive that stops
    // the calling session can wait for its own response to be delivered.
    const responseFinished = onceResponseFinished(reply.raw);
    await handleMcpRequest(request.raw, reply.raw, request.body, {
      whenResponseFinished: () => responseFinished,
      agent: {
        id: agent.id,
        cwd: agent.cwd,
        type: agent.type,
        role: agent.role,
        persona: agent.persona,
        parentAgentId: agent.parentAgentId,
        baseBranch: agent.baseBranch,
      },
      repoRoot,
      worktreeRoot,
      sendNotify: deps.mcpSendNotify,
      upsertEvent: deps.mcpUpsertEvent,
      renameSession: deps.mcpRenameSession,
      shareMedia: deps.mcpShareMedia,
      listMedia: deps.mcpListMedia,
      deleteMedia: deps.mcpDeleteMedia,
      getWhiteboard: deps.mcpGetWhiteboard,
      updateWhiteboard: deps.mcpUpdateWhiteboard,
      clearWhiteboard: deps.mcpClearWhiteboard,
      listPersonas: deps.mcpListPersonas,
      launchPersona: deps.mcpLaunchPersona,
      listPersonalities: deps.mcpListPersonalities,
      createPersonality: deps.mcpCreatePersonality,
      updatePersonality: deps.mcpUpdatePersonality,
      deletePersonality: deps.mcpDeletePersonality,
      setActivePersonality: deps.mcpSetActivePersonality,
      clearActivePersonality: deps.mcpClearActivePersonality,
      launchAgent: deps.mcpLaunchAgent,
      archiveAgent: deps.mcpArchiveAgent,
      resolveReviewFeedback: deps.mcpResolveReviewFeedback,
      reopenReviewFeedback: deps.mcpReopenReviewFeedback,
      submitReview: deps.mcpSubmitReview,
      addReviewFeedback: deps.mcpAddReviewFeedback,
      addReviewThreadMessage: deps.mcpAddReviewThreadMessage,
      listReviewFeedback: deps.mcpListReviewFeedback,
      getReviewFeedbackItem: deps.mcpGetReviewFeedbackItem,
      sendMessage: deps.mcpSendMessage,
      listAgentsForAgent: deps.mcpListAgentsForAgent,
      issueLoginLink: () => deps.loginLinkStore.issue(),
      upsertPin: deps.mcpUpsertPin,
      upsertPins: deps.mcpUpsertPins,
      deletePin: deps.mcpDeletePin,
      deletePinByLabel: deps.mcpDeletePinByLabel,
      listPins: deps.mcpListPins,
      getActivitySummary: (params: Record<string, unknown>) =>
        telemetry.getActivitySummary(deps.pool, params as never) as Promise<
          Record<string, unknown>
        >,
      getFeedbackSummary: (params: Record<string, unknown>) =>
        telemetry.getFeedbackSummary(deps.pool, params as never) as Promise<
          Record<string, unknown>
        >,
      crudTools: buildCrudCallbacks(deps),
      brainStore: deps.brainStore,
      publishBrainChanged: deps.publishBrainChanged,
      publishUiEvent: deps.publishUiEvent,
      surfaces: deps.surfaces,
      chat: deps.chat,
    } as Parameters<typeof handleMcpRequest>[3]);
  });

  app.get("/api/mcp", async (_, reply) => {
    return reply.code(405).send(deps.mcpMethodNotAllowed());
  });

  app.delete("/api/mcp", async (_, reply) => {
    return reply.code(405).send(deps.mcpMethodNotAllowed());
  });

  app.get("/api/mcp/:agentId", async (_, reply) => {
    return reply.code(405).send(deps.mcpMethodNotAllowed());
  });

  app.delete("/api/mcp/:agentId", async (_, reply) => {
    return reply.code(405).send(deps.mcpMethodNotAllowed());
  });
}
