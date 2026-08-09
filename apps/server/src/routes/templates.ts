import path from "node:path";

import type { FastifyInstance } from "fastify";
import * as z from "zod/v4";

import { AGENT_TYPES } from "../agent-type-settings.js";
import { errorMessage } from "../shared/lib/error-message.js";
import { parseInput } from "../shared/lib/parse-input.js";
import { resolveTilde } from "../shared/lib/resolve-tilde.js";
import {
  type StartupFileUpload,
  MAX_STARTUP_FILE_COUNT,
  createStartupPins,
  parseOptionalStringArrayField,
} from "./agent-startup.js";
import type { TemplateService } from "../templates/service.js";
import { parseTemplateArgs } from "../templates/store.js";
import {
  isMediaFile,
  isTextFile,
  sanitizeUploadedFileName,
} from "../shared/media.js";

const directoryField = z
  .string()
  .min(1, "Template directory is required.")
  .transform(resolveTilde);

const AddTemplateBodySchema = z.object({
  name: z.string().min(1, "Template name is required."),
  directory: directoryField,
  description: z.string().nullable().optional(),
  prompt: z.string().nullable().optional(),
  agentType: z.enum(AGENT_TYPES).optional(),
  model: z.string().nullable().optional(),
  useWorktree: z.boolean().optional(),
  baseBranch: z.string().nullable().optional(),
  branchName: z.string().nullable().optional(),
  fullAccess: z.boolean().optional(),
  callable: z.boolean().optional(),
  allowMedia: z.boolean().optional(),
  selfImprove: z.boolean().optional(),
});

const UpdateTemplateBodySchema = z.object({
  name: z.string().min(1).optional(),
  directory: directoryField.optional(),
  description: z.string().nullable().optional(),
  prompt: z.string().nullable().optional(),
  agentType: z.enum(AGENT_TYPES).optional(),
  model: z.string().nullable().optional(),
  useWorktree: z.boolean().optional(),
  baseBranch: z.string().nullable().optional(),
  branchName: z.string().nullable().optional(),
  fullAccess: z.boolean().optional(),
  callable: z.boolean().optional(),
  allowMedia: z.boolean().optional(),
  selfImprove: z.boolean().optional(),
});

const LaunchBodySchema = z.object({
  args: z.record(z.string(), z.string()).optional(),
  directory: directoryField.optional(),
  agentType: z.enum(AGENT_TYPES).optional(),
});

function classifyErrorCode(message: string): number {
  if (message.includes("not found")) return 404;
  if (message.includes("already exists") || message.includes("referenced by"))
    return 409;
  if (message.includes("Missing required") || message.includes("no prompt"))
    return 400;
  return 500;
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
    return await deps.templateService.listTemplates({ excludeJobBacked: true });
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
    const parsed = parseInput(AddTemplateBodySchema, request.body, reply);
    if (!parsed) return;
    try {
      const result = await deps.templateService.addTemplate(parsed);
      deps.publishUiEvent({ type: "template.changed" });
      return result;
    } catch (error) {
      const message = errorMessage(error);
      return reply.code(classifyErrorCode(message)).send({ error: message });
    }
  });

  app.patch<{ Params: { id: string } }>(
    "/api/v1/templates/:id",
    async (request, reply) => {
      const parsed = parseInput(UpdateTemplateBodySchema, request.body, reply);
      if (!parsed) return;
      try {
        const result = await deps.templateService.updateTemplate(
          request.params.id,
          parsed
        );
        deps.publishUiEvent({ type: "template.changed" });
        return result;
      } catch (error) {
        const message = errorMessage(error);
        return reply.code(classifyErrorCode(message)).send({ error: message });
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
        const message = errorMessage(error);
        return reply.code(classifyErrorCode(message)).send({ error: message });
      }
    }
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/templates/:id/launch",
    async (request, reply) => {
      let body: z.infer<typeof LaunchBodySchema> & {
        startupLinks?: unknown;
      };
      let startupFiles: StartupFileUpload[] = [];
      let isMultipart = false;

      if (request.isMultipart()) {
        isMultipart = true;
        const raw: Record<string, unknown> = {};
        const files: StartupFileUpload[] = [];
        for await (const rawPart of request.parts()) {
          const part = rawPart as {
            type: "file" | "field";
            fieldname: string;
            filename?: string;
            value?: unknown;
            toBuffer?: () => Promise<Buffer>;
          };
          if (part.type === "file") {
            if (part.fieldname !== "startupFiles") {
              return reply.code(400).send({ error: "Unexpected file field." });
            }
            if (files.length >= MAX_STARTUP_FILE_COUNT) {
              return reply.code(400).send({
                error: `A maximum of ${MAX_STARTUP_FILE_COUNT} startup files is allowed.`,
              });
            }
            const fileName = sanitizeUploadedFileName(
              path.basename(part.filename || "")
            );
            if (!fileName || !isMediaFile(fileName)) {
              return reply.code(400).send({
                error:
                  "Unsupported file type. Use images, video, documents, or text files.",
              });
            }
            if (!part.toBuffer) {
              return reply.code(400).send({ error: "Invalid file upload." });
            }
            files.push({
              fileName,
              originalName: fileName,
              buffer: await part.toBuffer(),
              source: isTextFile(fileName) ? "text" : "user",
              description: null,
            });
            continue;
          }
          raw[part.fieldname] = part.value;
        }
        startupFiles = files;

        if (raw.args && typeof raw.args === "string") {
          try {
            raw.args = JSON.parse(raw.args);
          } catch {
            return reply
              .code(400)
              .send({ error: "args must be a JSON object." });
          }
        }
        body = raw as typeof body;
      } else {
        body = (request.body ?? {}) as typeof body;
      }

      const parsed = parseInput(LaunchBodySchema, body, reply);
      if (!parsed) return;

      let startupLinks: string[] | undefined;
      try {
        startupLinks = parseOptionalStringArrayField(
          body.startupLinks,
          "startupLinks",
          isMultipart
        );
      } catch (error) {
        return reply.code(400).send({
          error: errorMessage(error),
        });
      }

      let startupPins: ReturnType<typeof createStartupPins> = [];
      if (startupLinks && startupLinks.length > 0) {
        try {
          startupPins = createStartupPins(startupLinks);
        } catch (error) {
          return reply.code(400).send({
            error: errorMessage(error),
          });
        }
      }

      try {
        const result = await deps.templateService.launchTemplate({
          templateId: request.params.id,
          ...parsed,
          startupFiles,
          startupPins,
        });
        deps.publishUiEvent({
          type: "agent.upsert",
          agent: result.agent,
        });
        return { agent: result.agent };
      } catch (error) {
        const message = errorMessage(error);
        return reply.code(classifyErrorCode(message)).send({ error: message });
      }
    }
  );
}
