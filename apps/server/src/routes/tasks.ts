import {
  parseCreateAgentRequest,
  parseOptionalStringArrayField,
  validateStartupLinks,
} from "./agent-startup.js";
import { sendStoredFile } from "../files/send-file.js";
import type { FastifyInstance, FastifyReply } from "fastify";
import * as z from "zod/v4";

import { AGENT_TYPES } from "../agent-type-settings.js";
import type { AgentRecord } from "../agents/manager.js";
import { parseInput } from "../shared/lib/parse-input.js";
import { TaskError, type TaskService } from "../tasks/service.js";
import type { TaskActor } from "../tasks/types.js";

type TaskRouteDeps = {
  taskService: TaskService;
  withStreamFlag: (agent: AgentRecord) => AgentRecord & { hasStream: boolean };
};

const USER: TaskActor = { kind: "user" };

const TriggerSchema = z.object({
  templateId: z.string().min(1, "trigger.templateId is required."),
  agentType: z.enum(AGENT_TYPES).nullable().optional(),
  model: z.string().nullable().optional(),
  assign: z.boolean().optional(),
  fireOnCreate: z.boolean().optional(),
});

const CreateColumnSchema = z.object({
  name: z.string().min(1, "name is required."),
  key: z.string().min(1).optional(),
  position: z.number().int().optional(),
  isDone: z.boolean().optional(),
  capacity: z.number().int().min(1).max(2147483647).nullable().optional(),
  trigger: TriggerSchema.nullable().optional(),
});

const UpdateColumnSchema = CreateColumnSchema.partial();

const LinkSchema = z.object({
  kind: z.enum(["pr", "branch", "url"]),
  url: z.string().nullable(),
  label: z.string(),
});

const CreateTaskSchema = z.object({
  projectId: z.string().min(1, "projectId is required."),
  title: z.string().min(1, "title is required."),
  body: z.string().optional(),
  columnId: z.string().min(1).optional(),
  position: z.number().optional(),
});

const UpdateTaskSchema = z.object({
  title: z.string().min(1).optional(),
  body: z.string().optional(),
  columnId: z.string().min(1).optional(),
  position: z.number().optional(),
  assignedAgentId: z.string().min(1).nullable().optional(),
  links: z.array(LinkSchema).max(100).optional(),
  confirmRelaunch: z.boolean().optional(),
});

const LaunchSchema = z.object({
  templateId: z.string().min(1, "templateId is required."),
  agentType: z.enum(AGENT_TYPES).nullable().optional(),
  model: z.string().nullable().optional(),
});

/**
 * Runs a service call, answering a `TaskError` with its status and code.
 * There is no app-level error handler, so anything else is a 500.
 */
async function mapTaskErrors<T>(
  reply: FastifyReply,
  run: () => Promise<T>
): Promise<T | FastifyReply> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof TaskError) {
      return reply.code(error.status).send({
        error: error.message,
        ...(error.code ? { code: error.code } : {}),
        ...error.extra,
      });
    }
    throw error;
  }
}

export async function registerTaskRoutes(
  app: FastifyInstance,
  deps: TaskRouteDeps
): Promise<void> {
  const { taskService } = deps;

  app.get<{
    Params: { projectId: string };
    Querystring: { archived?: string };
  }>("/api/v1/projects/:projectId/tasks/board", async (request, reply) =>
    mapTaskErrors(reply, () =>
      taskService.getBoard(request.params.projectId, {
        archived: request.query.archived === "1",
      })
    )
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/task-columns",
    async (request, reply) => {
      const input = parseInput(CreateColumnSchema, request.body, reply);
      if (!input) return reply;
      return mapTaskErrors(reply, () =>
        taskService.createColumn(request.params.projectId, input)
      );
    }
  );

  app.patch<{ Params: { id: string } }>(
    "/api/v1/task-columns/:id",
    async (request, reply) => {
      const input = parseInput(UpdateColumnSchema, request.body, reply);
      if (!input) return reply;
      return mapTaskErrors(reply, () =>
        taskService.updateColumn(request.params.id, input)
      );
    }
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/task-columns/:id",
    async (request, reply) =>
      mapTaskErrors(reply, async () => {
        await taskService.deleteColumn(request.params.id);
        return { deleted: true };
      })
  );

  app.get<{
    Querystring: {
      projectId?: string;
      assignedAgentId?: string;
      archived?: string;
    };
  }>("/api/v1/tasks", async (request, reply) => {
    const { projectId, assignedAgentId } = request.query;
    if (
      (projectId !== undefined && typeof projectId !== "string") ||
      (assignedAgentId !== undefined && typeof assignedAgentId !== "string")
    ) {
      return reply
        .code(400)
        .send({ error: "projectId and assignedAgentId take one value." });
    }
    return mapTaskErrors(reply, () =>
      taskService.listTasks({
        archived: request.query.archived === "1",
        projectId: projectId || undefined,
        assignedAgentId: assignedAgentId || undefined,
      })
    );
  });

  app.post("/api/v1/tasks", async (request, reply) => {
    let parsed;
    let links: string[];
    try {
      parsed = await parseCreateAgentRequest<Record<string, unknown>>(request);
      links = validateStartupLinks(
        parseOptionalStringArrayField(
          parsed.body.startupLinks,
          "startupLinks",
          parsed.isMultipart
        ) ?? []
      );
      if (parsed.isMultipart && parsed.body.position !== undefined)
        parsed.body.position = Number(parsed.body.position);
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const input = parseInput(CreateTaskSchema, parsed.body, reply);
    if (!input) return reply;
    return mapTaskErrors(reply, () =>
      taskService.createTask(input, USER, {
        startupFiles: parsed.startupFiles,
        startupLinks: links,
      })
    );
  });

  app.get<{ Params: { id: string } }>(
    "/api/v1/tasks/:id",
    async (request, reply) =>
      mapTaskErrors(reply, () => taskService.getTaskDetail(request.params.id))
  );

  app.get<{ Params: { id: string; attachmentId: string } }>(
    "/api/v1/tasks/:id/attachments/:attachmentId",
    async (request, reply) =>
      mapTaskErrors(reply, async () => {
        const attachmentId = Number(request.params.attachmentId);
        if (!Number.isSafeInteger(attachmentId) || attachmentId <= 0)
          return reply.code(400).send({ error: "Invalid attachment id." });
        const file = await taskService.attachmentFile(
          request.params.id,
          attachmentId
        );
        return sendStoredFile(request, reply, file.path, file.mimeType);
      })
  );

  for (const action of ["archive", "restore"] as const) {
    app.post<{ Params: { id: string } }>(
      `/api/v1/tasks/:id/${action}`,
      async (request, reply) =>
        mapTaskErrors(reply, () =>
          action === "archive"
            ? taskService.archiveTask(request.params.id, USER)
            : taskService.restoreTask(request.params.id, USER)
        )
    );
  }
  app.post<{ Params: { projectId: string; id: string } }>(
    "/api/v1/projects/:projectId/task-columns/:id/archive-tasks",
    async (request, reply) =>
      mapTaskErrors(reply, () =>
        taskService.archiveColumn(
          request.params.projectId,
          request.params.id,
          USER
        )
      )
  );

  app.patch<{ Params: { id: string } }>(
    "/api/v1/tasks/:id",
    async (request, reply) => {
      const input = parseInput(UpdateTaskSchema, request.body, reply);
      if (!input) return reply;
      return mapTaskErrors(reply, () =>
        taskService.updateTask(request.params.id, input, USER)
      );
    }
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/tasks/:id",
    async (request, reply) =>
      mapTaskErrors(reply, async () => {
        await taskService.deleteTask(request.params.id);
        return { deleted: true };
      })
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/tasks/:id/briefing",
    async (request, reply) =>
      mapTaskErrors(reply, () => taskService.briefingFor(request.params.id))
  );

  app.delete<{ Params: { id: string; agentId: string } }>(
    "/api/v1/tasks/:id/agents/:agentId",
    async (request, reply) =>
      mapTaskErrors(reply, () =>
        taskService.removeAgent(request.params.id, request.params.agentId, USER)
      )
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/tasks/:id/launch",
    async (request, reply) => {
      const input = parseInput(LaunchSchema, request.body, reply);
      if (!input) return reply;
      return mapTaskErrors(reply, async () => {
        const { agent } = await taskService.launchAgent(
          request.params.id,
          input,
          USER
        );
        return { agent: deps.withStreamFlag(agent) };
      });
    }
  );
}
