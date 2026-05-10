import os from "node:os";
import path from "node:path";

import type { FastifyInstance } from "fastify";
import * as z from "zod/v4";

import { CLI_AGENT_TYPES } from "../agent-type-settings.js";
import type { TemplateService } from "../templates/service.js";
import { parseTemplateArgs } from "../templates/store.js";

const directoryField = z
  .string()
  .min(1, "Template directory is required.")
  .transform(resolveTilde);

const AddTemplateBodySchema = z.object({
  name: z.string().min(1, "Template name is required."),
  directory: directoryField,
  prompt: z.string().nullable().optional(),
  agentType: z.enum(CLI_AGENT_TYPES).optional(),
  useWorktree: z.boolean().optional(),
  baseBranch: z.string().nullable().optional(),
  branchName: z.string().nullable().optional(),
  fullAccess: z.boolean().optional(),
  callable: z.boolean().optional(),
});

const UpdateTemplateBodySchema = z.object({
  name: z.string().min(1).optional(),
  prompt: z.string().nullable().optional(),
  agentType: z.enum(CLI_AGENT_TYPES).optional(),
  useWorktree: z.boolean().optional(),
  baseBranch: z.string().nullable().optional(),
  branchName: z.string().nullable().optional(),
  fullAccess: z.boolean().optional(),
  callable: z.boolean().optional(),
});

const LaunchBodySchema = z.object({
  args: z.record(z.string(), z.string()).optional(),
  directory: directoryField.optional(),
});

function resolveTilde(value: string): string {
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  if (value === "~") return os.homedir();
  return value;
}

type TemplateRouteDeps = {
  templateService: TemplateService;
  publishUiEvent: (event: unknown) => void;
};

export async function registerTemplateRoutes(
  app: FastifyInstance,
  deps: TemplateRouteDeps
): Promise<void> {
  app.get("/api/v1/templates", async () => {
    return await deps.templateService.listTemplates();
  });

  app.get<{ Params: { id: string } }>(
    "/api/v1/templates/:id",
    async (request, reply) => {
      const template = await deps.templateService.getTemplate(
        request.params.id
      );
      if (!template) {
        return reply.code(404).send({ error: "Template not found." });
      }
      const args = template.prompt ? parseTemplateArgs(template.prompt) : [];
      return { ...template, args };
    }
  );

  app.post("/api/v1/templates", async (request, reply) => {
    const parsed = AddTemplateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message });
    }
    try {
      const result = await deps.templateService.addTemplate(parsed.data);
      deps.publishUiEvent({ type: "template.changed" });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ error: message });
    }
  });

  app.patch<{ Params: { id: string } }>(
    "/api/v1/templates/:id",
    async (request, reply) => {
      const parsed = UpdateTemplateBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0].message });
      }
      try {
        const result = await deps.templateService.updateTemplate(
          request.params.id,
          parsed.data
        );
        deps.publishUiEvent({ type: "template.changed" });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.code(500).send({ error: message });
      }
    }
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/templates/:id",
    async (request, reply) => {
      try {
        const result = await deps.templateService.removeTemplate(
          request.params.id
        );
        deps.publishUiEvent({ type: "template.changed" });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.code(500).send({ error: message });
      }
    }
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/templates/:id/launch",
    async (request, reply) => {
      const parsed = LaunchBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0].message });
      }
      try {
        const result = await deps.templateService.launchTemplate({
          templateId: request.params.id,
          ...parsed.data,
        });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.code(500).send({ error: message });
      }
    }
  );
}
