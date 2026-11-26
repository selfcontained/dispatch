import { runnerIdForPlacement } from "../runners/placement.js";
import {
  readStoredModelCatalog,
  selectableAgentModels,
} from "../shared/agent-models.js";
import { createRiskReader } from "../shared/mcp/pull-request-risk-tools.js";
import type { PullRequestRefresher } from "../agents/pull-request-refresher.js";
import { inProcessEngines, localEngineCalls } from "../runners/local.js";
import { createRunnerUsage } from "../agents/codex-reset.js";
import type { RedeemCodexReset } from "../agents/codex-reset.js";
import type { ScheduledMessageService } from "../scheduled-messages/service.js";

import type { FastifyInstance } from "fastify";
import { isJSONRPCRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Pool } from "pg";
import type { SharedUiEvent } from "@dispatch/shared";

import { getEnabledAgentTypes } from "../agent-type-settings.js";
import type { ProviderPlansReporter } from "../agents/provider-plans-reporter.js";
import type { UsageCallbacks } from "../shared/mcp/usage-tools.js";
import type { AgentManager, AgentRecord } from "../agents/manager.js";
import { agentWorkspaceDir } from "../agents/workspace-target.js";
import { sameRunner } from "@dispatch/runner-protocol/contract";
import { controllerPlacement, enrolledRunnerId } from "../runners/placement.js";
import {
  identityKey,
  PROJECT_IDENTITY_SQL,
  repositoryKey,
  SESSION_REPOSITORY_SQL,
  type ProjectIdentity,
} from "../runners/repository-identity.js";
import {
  defaultSavedTarget,
  normalizeSavedDirectory,
  targetPlacement,
} from "../runners/saved-location.js";
import * as telemetry from "../agents/telemetry.js";
import type { LoginLinkStore } from "../auth.js";
import type { BrainStore } from "../brain/store.js";
import type { AddJobInput, JobService } from "../jobs/service.js";
import type { UpdateJobInput } from "../jobs/store.js";
import type { TemplateService } from "../templates/service.js";
import type { AddTemplateInput } from "../templates/store.js";
import {
  personaScopeFor,
  savedPersonaScope,
  type SavedPersonaScope,
} from "../personas/persona-scope.js";
import { discoverRepoTools, mcpCheckoutRoots } from "../server/mcp-checkout.js";
import { sessionPersonaFiles } from "../personas/checkout-files.js";
import type { CrudToolCallbacks } from "../shared/mcp/crud-tools.js";
import { handleMcpRequest } from "../shared/mcp/server.js";
import type { StreamService } from "../chat/service.js";
import type { TaskService } from "../tasks/service.js";

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

function isOwnerReviewRequest(body: unknown): boolean {
  const messages: unknown[] = Array.isArray(body) ? body : [body];
  return (
    messages.length > 0 &&
    messages.every(
      (message) =>
        isJSONRPCRequest(message) &&
        message.method === "tools/call" &&
        message.params?.name === "launch_owner_reviews"
    )
  );
}

async function checkoutContext(
  deps: McpRouteDeps,
  agent: NonNullable<Awaited<ReturnType<AgentManager["getAgent"]>>>,
  body: unknown
) {
  const placement = enrolledRunnerId(agent.placement ?? controllerPlacement);
  const workspaceDir = agentWorkspaceDir(agent) ?? agent.cwd;
  const ownerOnly = isOwnerReviewRequest(body);
  const roots = ownerOnly
    ? null
    : await mcpCheckoutRoots(deps.agentManager, agent);
  const hasCheckout =
    !roots || Boolean(roots.checkoutRoot || roots.repositoryRoot);
  const callerPlacement = agent.placement ?? controllerPlacement;
  // The runner's machine-local paths never become host paths or keys.
  const repoRoot = identityKey(callerPlacement, roots?.repositoryRoot ?? null);
  // Like repoRoot: a runner's machine-local path is never a host path.
  const worktreeRoot = identityKey(
    callerPlacement,
    roots?.checkoutRoot ?? null
  );
  // Persona authoring reads and writes in the checkout through its runner.
  const persona =
    roots && (roots.checkoutRoot || roots.repositoryRoot)
      ? sessionPersonaFiles(deps.agentManager, agent)
      : null;
  // One key (D5, D8) for Brain, the agent list and PR-risk visibility.
  const repositoryScope = await repositoryKey({
    placement: callerPlacement,
    repositoryRoot: async () => repoRoot,
    project: async () =>
      agent.projectId
        ? ((
            await deps.pool.query<ProjectIdentity>(PROJECT_IDENTITY_SQL, [
              agent.projectId,
            ])
          ).rows[0] ?? null)
        : null,
    repository: async () =>
      (
        await deps.pool.query<{ url: string | null }>(SESSION_REPOSITORY_SQL, [
          agent.id,
        ])
      ).rows[0]?.url ?? null,
  });
  return {
    workspaceDir,
    repoRoot,
    repositoryScope,
    context: {
      worktreeRoot,
      brainRepoRoot: repositoryScope,
      ...(persona && {
        personaFiles: persona.files,
        personaWrites: persona.writes,
      }),
      toolsRoot: hasCheckout && placement ? workspaceDir : undefined,
      listSessionPersonas: hasCheckout,
      discoverRepoTools: ownerOnly
        ? async () => []
        : () => discoverRepoTools(deps.agentManager, agent),
    },
  };
}

type McpRouteDeps = {
  pullRequests?: Pick<PullRequestRefresher, "get">;
  riskEnabled?: () => Promise<boolean>;
  usageForAgent?: (id: string) => Promise<{
    providerPlans: ProviderPlansReporter;
    redeemCodexReset: RedeemCodexReset;
  }>;
  redeemCodexReset?: RedeemCodexReset;
  usageWatches?: UsageCallbacks["usageWatches"];
  providerPlans?: ProviderPlansReporter;
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
  taskService?: TaskService;
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
  mcpRenameSession: unknown;
  mcpSetWorkspace: unknown;
  mcpShareFile: unknown;
  mcpListFiles: unknown;
  mcpDeleteFile: unknown;
  mcpListPersonas: unknown;
  mcpLaunchOwnerReviews?: unknown;
  mcpListPersonalities: unknown;
  mcpCreatePersonality: unknown;
  mcpUpdatePersonality: unknown;
  mcpDeletePersonality: unknown;
  mcpSetActivePersonality: unknown;
  mcpClearActivePersonality: unknown;
  mcpLaunchAgent: unknown;
  mcpArchiveAgent: unknown;
  mcpJobComplete: unknown;
  mcpJobFailed: unknown;
  mcpJobNeedsInput: unknown;
  mcpJobLog: unknown;
  mcpListAgentsForAgent: unknown;
  mcpMethodNotAllowed: () => unknown;
  scheduledMessages?: ScheduledMessageService;
  chat: Pick<
    StreamService,
    "post" | "update" | "addReaction" | "removeReaction"
  >;
};

function buildCrudCallbacks(
  deps: McpRouteDeps,
  agent: AgentRecord
): CrudToolCallbacks {
  const callerFullAccess = agent.fullAccess === true;
  const callerPlacement = agent.placement ?? controllerPlacement;
  const personaScope: SavedPersonaScope = (target) =>
    !sameRunner(callerPlacement, controllerPlacement) &&
    sameRunner(callerPlacement, target.placement ?? controllerPlacement)
      ? personaScopeFor({ manager: deps.agentManager, agent })
      : savedPersonaScope(deps.agentManager)(target);

  // The default directory names the caller's session. A supplied native folder
  // uses the controller's directory namespace, as saved launches do.
  const scopeFor = (directory: string) =>
    directory === agent.cwd ? callerPlacement : controllerPlacement;
  return {
    listJobs: async (directory) => {
      const jobs = await deps.jobService.listJobs();
      if (!directory) return jobs;
      const placement = scopeFor(directory);
      const resolved = normalizeSavedDirectory(
        directory,
        runnerIdForPlacement(placement)
      );
      return jobs.filter(
        (j) =>
          j.directory === resolved && sameRunner(targetPlacement(j), placement)
      );
    },
    getJobById: (jobId) => deps.jobService.getJobById(jobId),
    getJobByName: (directory, name) =>
      deps.jobService.getJobByName(
        directory,
        name,
        runnerIdForPlacement(scopeFor(directory))
      ),
    createJob: (input, defaultDirectory) =>
      deps.jobService.addJob(
        defaultSavedTarget(input, agent, defaultDirectory) as AddJobInput,
        callerFullAccess,
        personaScope
      ),
    updateJob: (input) =>
      deps.jobService.updateJob(
        input as UpdateJobInput,
        callerFullAccess,
        personaScope
      ),
    deleteJob: (jobId) => deps.jobService.removeJob({ jobId }),
    runJob: (jobId) =>
      deps.jobService.runJob({
        jobId,
        wait: false,
        callerFullAccess,
      }),
    listTemplates: async (directory) => {
      const templates = await deps.templateService.listTemplates();
      if (!directory) return templates;
      const placement = scopeFor(directory);
      const resolved = normalizeSavedDirectory(
        directory,
        runnerIdForPlacement(placement)
      );
      return templates.filter(
        (t) =>
          t.directory === resolved && sameRunner(targetPlacement(t), placement)
      );
    },
    getTemplateById: (templateId) =>
      deps.templateService.getTemplate(templateId),
    getTemplateByName: (directory, name) =>
      deps.templateService.getTemplateByName(
        directory,
        name,
        runnerIdForPlacement(scopeFor(directory))
      ),
    createTemplate: (input, defaultDirectory) =>
      deps.templateService.addTemplate(
        defaultSavedTarget(input, agent, defaultDirectory) as AddTemplateInput,
        callerFullAccess,
        personaScope
      ),
    updateTemplate: (templateId, input) =>
      deps.templateService.updateTemplate(
        templateId,
        input as Partial<AddTemplateInput>,
        callerFullAccess,
        personaScope
      ),
    deleteTemplate: (templateId) =>
      deps.templateService.removeTemplate(templateId),
  };
}

export async function registerMcpRoutes(
  app: FastifyInstance,
  deps: McpRouteDeps
): Promise<void> {
  const fallbackEngines = deps.providerPlans
    ? undefined
    : inProcessEngines(undefined);
  if (fallbackEngines)
    app.addHook("onClose", async () => fallbackEngines.close());
  const providerPlans =
    deps.providerPlans ??
    createRunnerUsage(localEngineCalls(() => undefined, fallbackEngines!))
      .providerPlans;

  function modelOptionsForRunner(
    runnerId: string
  ): NonNullable<UsageCallbacks["modelOptions"]> {
    return async (engine) => {
      readStoredModelCatalog(runnerId, engine);
      return selectableAgentModels(engine, runnerId);
    };
  }

  const enabledAgentTypes = () => getEnabledAgentTypes(deps.pool);

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

    const placement = enrolledRunnerId(agent.placement ?? controllerPlacement);
    if (placement && !deps.agentManager.permitsRemoteAgentMcp(placement)) {
      return reply
        .code(403)
        .send({ error: "The runner registration is no longer active." });
    }

    const run = await deps.jobService.getActiveRunForAgent(agentId);
    if (run && run.id !== runId) {
      return reply
        .code(403)
        .send({ error: "Token does not match the active job run." });
    }

    const checkout = await checkoutContext(deps, agent, request.body);
    const { workspaceDir, repoRoot, repositoryScope } = checkout;

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
              model: a.model ?? null,
              effort: a.effort ?? null,
              cwd: a.cwd,
            }));
          },
          getFeedbackSummary: (params: Record<string, unknown>) =>
            telemetry.getFeedbackSummary(deps.pool, params as never),
        }
      : undefined;

    reply.hijack();
    // Captured before the transport writes anything, so an archive that stops
    // the calling session can wait for its own response to be delivered.
    const responseFinished = onceResponseFinished(reply.raw);
    await handleMcpRequest(request.raw, reply.raw, request.body, {
      readPullRequestRisk: createRiskReader({
        caller: agent,
        getAgent: (id) => deps.agentManager.getAgent(id),
        visibleAgents: () =>
          (
            deps.mcpListAgentsForAgent as (
              id: string,
              root: string | null
            ) => Promise<{ id: string }[]>
          )(agent.id, repositoryScope),
        inventory: deps.pullRequests,
        enabled: deps.riskEnabled,
      }),
      providerPlans: deps.usageForAgent
        ? (await deps.usageForAgent(agent.id)).providerPlans
        : providerPlans,
      modelOptions: modelOptionsForRunner(
        runnerIdForPlacement(agent.placement)
      ),
      usageWatches: deps.usageWatches,
      redeemCodexReset: bearerToken
        ? deps.usageForAgent
          ? (await deps.usageForAgent(agent.id)).redeemCodexReset
          : deps.redeemCodexReset
        : undefined,
      enabledAgentTypes,
      whenResponseFinished: () => responseFinished,
      agent: {
        id: agent.id,
        cwd: workspaceDir,
        type: agent.type,
        role: agent.role,
        persona: agent.persona,
        parentAgentId: agent.parentAgentId,
        baseBranch: agent.baseBranch,
        projectId: agent.projectId ?? null,
        fullAccess: agent.fullAccess === true,
      },
      repoRoot,
      ...checkout.context,
      sendNotify: deps.mcpSendNotify,
      renameSession: deps.mcpRenameSession,
      setWorkspace: deps.mcpSetWorkspace,
      shareFile: deps.mcpShareFile,
      listFiles: deps.mcpListFiles,
      deleteFile: deps.mcpDeleteFile,
      listPersonas: deps.mcpListPersonas,
      launchOwnerReviews: deps.mcpLaunchOwnerReviews,
      listPersonalities: deps.mcpListPersonalities,
      createPersonality: deps.mcpCreatePersonality,
      updatePersonality: deps.mcpUpdatePersonality,
      deletePersonality: deps.mcpDeletePersonality,
      setActivePersonality: deps.mcpSetActivePersonality,
      clearActivePersonality: deps.mcpClearActivePersonality,
      launchAgent: deps.mcpLaunchAgent,
      archiveAgent: deps.mcpArchiveAgent,
      // list_agents takes the caller's repository key, not its host root.
      listAgentsForAgent: (id: string) =>
        (
          deps.mcpListAgentsForAgent as (
            id: string,
            root: string | null
          ) => Promise<unknown>
        )(id, repositoryScope),
      getFeedbackSummary: (params: Record<string, unknown>) =>
        telemetry.getFeedbackSummary(deps.pool, params as never) as Promise<
          Record<string, unknown>
        >,
      toolScope: run ? "job" : "agent",
      jobTools,
      crudTools: buildCrudCallbacks(deps, agent),
      brainStore: deps.brainStore,
      publishBrainChanged: deps.publishBrainChanged,
      taskService: deps.taskService,
      publishUiEvent: deps.publishUiEvent,
      scheduledMessages: deps.scheduledMessages,
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

    const placement = enrolledRunnerId(agent.placement ?? controllerPlacement);
    if (placement && !deps.agentManager.permitsRemoteAgentMcp(placement)) {
      return reply
        .code(403)
        .send({ error: "The runner registration is no longer active." });
    }

    const activeJobRun = await deps.jobService.getActiveRunForAgent(agentId);
    if (activeJobRun) {
      return reply
        .code(403)
        .send({ error: "Job agents must use the job-scoped MCP route." });
    }

    const checkout = await checkoutContext(deps, agent, request.body);
    const { workspaceDir, repoRoot, repositoryScope } = checkout;

    reply.hijack();
    // Captured before the transport writes anything, so an archive that stops
    // the calling session can wait for its own response to be delivered.
    const responseFinished = onceResponseFinished(reply.raw);
    await handleMcpRequest(request.raw, reply.raw, request.body, {
      readPullRequestRisk: createRiskReader({
        caller: agent,
        getAgent: (id) => deps.agentManager.getAgent(id),
        visibleAgents: () =>
          (
            deps.mcpListAgentsForAgent as (
              id: string,
              root: string | null
            ) => Promise<{ id: string }[]>
          )(agent.id, repositoryScope),
        inventory: deps.pullRequests,
        enabled: deps.riskEnabled,
      }),
      providerPlans: deps.usageForAgent
        ? (await deps.usageForAgent(agent.id)).providerPlans
        : providerPlans,
      modelOptions: modelOptionsForRunner(
        runnerIdForPlacement(agent.placement)
      ),
      usageWatches: deps.usageWatches,
      redeemCodexReset: bearerToken
        ? deps.usageForAgent
          ? (await deps.usageForAgent(agent.id)).redeemCodexReset
          : deps.redeemCodexReset
        : undefined,
      enabledAgentTypes,
      whenResponseFinished: () => responseFinished,
      agent: {
        id: agent.id,
        cwd: workspaceDir,
        type: agent.type,
        role: agent.role,
        persona: agent.persona,
        parentAgentId: agent.parentAgentId,
        baseBranch: agent.baseBranch,
        projectId: agent.projectId ?? null,
        fullAccess: agent.fullAccess === true,
      },
      repoRoot,
      ...checkout.context,
      sendNotify: deps.mcpSendNotify,
      renameSession: deps.mcpRenameSession,
      setWorkspace: deps.mcpSetWorkspace,
      shareFile: deps.mcpShareFile,
      listFiles: deps.mcpListFiles,
      deleteFile: deps.mcpDeleteFile,
      listPersonas: deps.mcpListPersonas,
      launchOwnerReviews: deps.mcpLaunchOwnerReviews,
      listPersonalities: deps.mcpListPersonalities,
      createPersonality: deps.mcpCreatePersonality,
      updatePersonality: deps.mcpUpdatePersonality,
      deletePersonality: deps.mcpDeletePersonality,
      setActivePersonality: deps.mcpSetActivePersonality,
      clearActivePersonality: deps.mcpClearActivePersonality,
      launchAgent: deps.mcpLaunchAgent,
      archiveAgent: deps.mcpArchiveAgent,
      // list_agents takes the caller's repository key, not its host root.
      listAgentsForAgent: (id: string) =>
        (
          deps.mcpListAgentsForAgent as (
            id: string,
            root: string | null
          ) => Promise<unknown>
        )(id, repositoryScope),
      issueLoginLink: () => deps.loginLinkStore.issue(),
      getFeedbackSummary: (params: Record<string, unknown>) =>
        telemetry.getFeedbackSummary(deps.pool, params as never) as Promise<
          Record<string, unknown>
        >,
      crudTools: buildCrudCallbacks(deps, agent),
      brainStore: deps.brainStore,
      publishBrainChanged: deps.publishBrainChanged,
      taskService: deps.taskService,
      publishUiEvent: deps.publishUiEvent,
      scheduledMessages: deps.scheduledMessages,
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
