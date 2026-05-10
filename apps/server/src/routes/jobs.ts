import os from "node:os";
import path from "node:path";

import type { FastifyInstance } from "fastify";
import * as z from "zod/v4";

import { CLI_AGENT_TYPES } from "../agent-type-settings.js";
import type { JobService } from "../jobs/service.js";

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
  enabled: z.boolean().optional(),
});
const JobHistoryParamsSchema = z.object({
  name: z.string().min(1, "Job name is required."),
  directory: directoryField,
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

function resolveTilde(value: string): string {
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  if (value === "~") return os.homedir();
  return value;
}

type JobsRouteDeps = {
  jobService: JobService;
  publishUiEvent: (event: unknown) => void;
};

export async function registerJobRoutes(
  app: FastifyInstance,
  deps: JobsRouteDeps
): Promise<void> {
  app.post("/api/v1/jobs/run", async (request, reply) => {
    const parsed = RunJobBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message });
    }

    try {
      const result = await deps.jobService.runJob(parsed.data);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ error: message });
    }
  });

  app.get("/api/v1/jobs", async () => {
    return await deps.jobService.listJobs();
  });

  app.post("/api/v1/jobs", async (request, reply) => {
    const parsed = AddJobBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message });
    }
    try {
      const result = await deps.jobService.addJob(parsed.data);
      deps.publishUiEvent({ type: "job.changed" });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ error: message });
    }
  });

  app.patch("/api/v1/jobs", async (request, reply) => {
    const parsed = AddJobBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message });
    }
    try {
      const result = await deps.jobService.updateJob(parsed.data);
      deps.publishUiEvent({ type: "job.changed" });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ error: message });
    }
  });

  app.delete("/api/v1/jobs", async (request, reply) => {
    const parsed = JobEnableDisableBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message });
    }
    try {
      const result = await deps.jobService.removeJob(parsed.data);
      deps.publishUiEvent({ type: "job.changed" });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ error: message });
    }
  });

  app.post("/api/v1/jobs/enable", async (request, reply) => {
    const parsed = JobEnableDisableBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message });
    }
    try {
      const result = await deps.jobService.enableJob(parsed.data);
      deps.publishUiEvent({ type: "job.changed" });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ error: message });
    }
  });

  app.post("/api/v1/jobs/disable", async (request, reply) => {
    const parsed = JobEnableDisableBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message });
    }
    try {
      const result = await deps.jobService.disableJob(parsed.data);
      deps.publishUiEvent({ type: "job.changed" });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ error: message });
    }
  });

  app.get("/api/v1/jobs/stats", async (_request, reply) => {
    try {
      return await deps.jobService.getStats();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ error: message });
    }
  });

  app.get("/api/v1/jobs/history", async (request, reply) => {
    const parsed = JobHistoryParamsSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message });
    }
    try {
      return await deps.jobService.listRunsForJob(parsed.data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(404).send({ error: message });
    }
  });
}
