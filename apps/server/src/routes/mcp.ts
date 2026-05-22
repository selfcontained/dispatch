import type { FastifyInstance } from "fastify";

import type { AgentManager } from "../agents/manager.js";
import type { BrainStore } from "../brain/store.js";
import type { JobService } from "../jobs/service.js";
import {
  resolveRepoRoot,
  resolveWorktreeRoot,
} from "../shared/git/git-context.js";
import { handleMcpRequest } from "../shared/mcp/server.js";

type McpRouteDeps = {
  config: {
    authToken: string;
  };
  agentManager: AgentManager;
  jobService: JobService;
  brainStore: BrainStore;
  publishBrainChanged: (repoRoot: string) => void;
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
  mcpSubmitFeedback: unknown;
  mcpListPersonas: unknown;
  mcpLaunchPersona: unknown;
  mcpGetFeedback: unknown;
  mcpResolveFeedback: unknown;
  mcpSubmitResolution: unknown;
  mcpCancelRecheck: unknown;
  mcpUpsertPin: unknown;
  mcpDeletePin: unknown;
  mcpGetParentContext: unknown;
  mcpGetRecheckContext: unknown;
  mcpUpdateReviewStatus: unknown;
  mcpCompleteReview: unknown;
  mcpJobComplete: unknown;
  mcpJobFailed: unknown;
  mcpJobNeedsInput: unknown;
  mcpJobLog: unknown;
  mcpMethodNotAllowed: () => unknown;
};

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
          listRecentPersonaReviews: (sinceDays: number) =>
            deps.agentManager.listRecentPersonaReviews(sinceDays),
          listRecentFeedback: (sinceDays: number) =>
            deps.agentManager.listRecentFeedback(sinceDays),
          getActivitySummary: (params: Record<string, unknown>) =>
            deps.agentManager.getActivitySummary(params as never),
          getAgentHistory: (params: Record<string, unknown>) =>
            deps.agentManager.getAgentHistory(params as never),
          getFeedbackSummary: (params: Record<string, unknown>) =>
            deps.agentManager.getFeedbackSummary(params as never),
        }
      : undefined;

    reply.hijack();
    await handleMcpRequest(request.raw, reply.raw, request.body, {
      agent: {
        id: agent.id,
        cwd: agent.cwd,
        persona: agent.persona,
        parentAgentId: agent.parentAgentId,
        baseBranch: agent.baseBranch,
        review: null,
      },
      repoRoot,
      worktreeRoot,
      sendNotify: deps.mcpSendNotify,
      upsertEvent: deps.mcpUpsertEvent,
      renameSession: deps.mcpRenameSession,
      shareMedia: deps.mcpShareMedia,
      listMedia: deps.mcpListMedia,
      submitFeedback: deps.mcpSubmitFeedback,
      upsertPin: deps.mcpUpsertPin,
      deletePin: deps.mcpDeletePin,
      listPersonas: deps.mcpListPersonas,
      launchPersona: deps.mcpLaunchPersona,
      getFeedback: deps.mcpGetFeedback,
      resolveFeedback: deps.mcpResolveFeedback,
      submitResolution: deps.mcpSubmitResolution,
      cancelRecheck: deps.mcpCancelRecheck,
      getActivitySummary: (params: Record<string, unknown>) =>
        deps.agentManager.getActivitySummary(params as never) as Promise<
          Record<string, unknown>
        >,
      getAgentHistory: (params: Record<string, unknown>) =>
        deps.agentManager.getAgentHistory(params as never) as Promise<
          Record<string, unknown>
        >,
      getFeedbackSummary: (params: Record<string, unknown>) =>
        deps.agentManager.getFeedbackSummary(params as never) as Promise<
          Record<string, unknown>
        >,
      toolScope: run ? "job" : "agent",
      jobTools,
      brainStore: deps.brainStore,
      publishBrainChanged: deps.publishBrainChanged,
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

    const review = agent.persona
      ? await deps.agentManager.getPersonaReview(agentId)
      : null;
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
    await handleMcpRequest(request.raw, reply.raw, request.body, {
      agent: {
        id: agent.id,
        cwd: agent.cwd,
        persona: agent.persona,
        parentAgentId: agent.parentAgentId,
        baseBranch: agent.baseBranch,
        review: review
          ? { allowRecheck: review.allowRecheck, status: review.status }
          : null,
      },
      repoRoot,
      worktreeRoot,
      sendNotify: deps.mcpSendNotify,
      upsertEvent: deps.mcpUpsertEvent,
      renameSession: deps.mcpRenameSession,
      shareMedia: deps.mcpShareMedia,
      listMedia: deps.mcpListMedia,
      submitFeedback: deps.mcpSubmitFeedback,
      listPersonas: deps.mcpListPersonas,
      launchPersona: deps.mcpLaunchPersona,
      getFeedback: deps.mcpGetFeedback,
      resolveFeedback: deps.mcpResolveFeedback,
      submitResolution: deps.mcpSubmitResolution,
      cancelRecheck: deps.mcpCancelRecheck,
      upsertPin: deps.mcpUpsertPin,
      deletePin: deps.mcpDeletePin,
      getParentContext: deps.mcpGetParentContext,
      getRecheckContext: deps.mcpGetRecheckContext,
      updateReviewStatus: deps.mcpUpdateReviewStatus,
      completeReview: deps.mcpCompleteReview,
      getActivitySummary: (params: Record<string, unknown>) =>
        deps.agentManager.getActivitySummary(params as never) as Promise<
          Record<string, unknown>
        >,
      getAgentHistory: (params: Record<string, unknown>) =>
        deps.agentManager.getAgentHistory(params as never) as Promise<
          Record<string, unknown>
        >,
      getFeedbackSummary: (params: Record<string, unknown>) =>
        deps.agentManager.getFeedbackSummary(params as never) as Promise<
          Record<string, unknown>
        >,
      brainStore: deps.brainStore,
      publishBrainChanged: deps.publishBrainChanged,
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
