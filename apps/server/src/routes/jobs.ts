import type { FastifyInstance } from "fastify";
import * as z from "zod/v4";

import { CLI_AGENT_TYPES } from "../agent-type-settings.js";
import type { JobService } from "../jobs/service.js";
import { errorMessage } from "../shared/lib/error-message.js";
import { parseInput } from "../shared/lib/parse-body.js";
import { resolveTilde } from "../shared/lib/resolve-tilde.js";

const directoryField = z
  .string()
  .min(1, "Job directory is required.")
  .transform(resolveTilde);
const RunJobBodySchema = z.object({
  name: z.string().min(1, "Job name is required."),
  directory: directoryField,
  wait: z.boolean().optional(),
});
const JobEnableDisableBodySchema = z.object({
  name: z.string().min(1, "Job name is required."),
  directory: directoryField,
});
const AddJobBodySchema = JobEnableDisableBodySchema.extend({
  displayName: z.string().optional(),
  prompt: z.string().nullable().optional(),
  schedule: z.string().nullable().optional(),
  timeoutMs: z.number().int().positive().optional(),
  needsInputTimeoutMs: z.number().int().positive().optional(),
  agentType: z.enum(CLI_AGENT_TYPES).optional(),
  useWorktree: z.boolean().optional(),
  baseBranch: z.string().nullable().optional(),
  branchName: z.string().nullable().optional(),
  fullAccess: z.boolean().optional(),
  autoArchive: z.boolean().optional(),
  callable: z.boolean().optional(),
  singleton: z.boolean().optional(),
  defaultArgs: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
});
const JobHistoryParamsSchema = z.object({
  name: z.string().min(1, "Job name is required."),
  directory: directoryField,
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

type JobsRouteDeps = {
  jobService: JobService;
  publishUiEvent: (event: unknown) => void;
};

export async function registerJobRoutes(
  app: FastifyInstance,
  deps: JobsRouteDeps
): Promise<void> {
  app.post("/api/v1/jobs/run", async (request, reply) => {
    const parsed = parseInput(RunJobBodySchema, request.body, reply);
    if (!parsed) return;

    try {
      const result = await deps.jobService.runJob(parsed);
      return result;
    } catch (error) {
      const message = errorMessage(error);
      return reply.code(500).send({ error: message });
    }
  });

  app.get("/api/v1/jobs", async () => {
    return await deps.jobService.listJobs();
  });

  app.post("/api/v1/jobs", async (request, reply) => {
    const parsed = parseInput(AddJobBodySchema, request.body, reply);
    if (!parsed) return;
    try {
      const result = await deps.jobService.addJob(parsed);
      deps.publishUiEvent({ type: "job.changed" });
      return result;
    } catch (error) {
      const message = errorMessage(error);
      return reply.code(500).send({ error: message });
    }
  });

  app.patch("/api/v1/jobs", async (request, reply) => {
    const parsed = parseInput(AddJobBodySchema, request.body, reply);
    if (!parsed) return;
    try {
      const result = await deps.jobService.updateJob(parsed);
      deps.publishUiEvent({ type: "job.changed" });
      return result;
    } catch (error) {
      const message = errorMessage(error);
      return reply.code(500).send({ error: message });
    }
  });

  app.delete("/api/v1/jobs", async (request, reply) => {
    const parsed = parseInput(JobEnableDisableBodySchema, request.body, reply);
    if (!parsed) return;
    try {
      const result = await deps.jobService.removeJob(parsed);
      deps.publishUiEvent({ type: "job.changed" });
      return result;
    } catch (error) {
      const message = errorMessage(error);
      return reply.code(500).send({ error: message });
    }
  });

  app.post("/api/v1/jobs/enable", async (request, reply) => {
    const parsed = parseInput(JobEnableDisableBodySchema, request.body, reply);
    if (!parsed) return;
    try {
      const result = await deps.jobService.enableJob(parsed);
      deps.publishUiEvent({ type: "job.changed" });
      return result;
    } catch (error) {
      const message = errorMessage(error);
      return reply.code(500).send({ error: message });
    }
  });

  app.post("/api/v1/jobs/disable", async (request, reply) => {
    const parsed = parseInput(JobEnableDisableBodySchema, request.body, reply);
    if (!parsed) return;
    try {
      const result = await deps.jobService.disableJob(parsed);
      deps.publishUiEvent({ type: "job.changed" });
      return result;
    } catch (error) {
      const message = errorMessage(error);
      return reply.code(500).send({ error: message });
    }
  });

  app.get("/api/v1/jobs/stats", async (_request, reply) => {
    try {
      return await deps.jobService.getStats();
    } catch (error) {
      const message = errorMessage(error);
      return reply.code(500).send({ error: message });
    }
  });

  app.get("/api/v1/jobs/history", async (request, reply) => {
    const parsed = parseInput(JobHistoryParamsSchema, request.query, reply);
    if (!parsed) return;
    try {
      return await deps.jobService.listRunsForJob(parsed);
    } catch (error) {
      const message = errorMessage(error);
      return reply.code(404).send({ error: message });
    }
  });
}
