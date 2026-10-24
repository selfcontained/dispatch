import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import {
  mergeLinks,
  TaskError,
  type TaskService,
} from "../../tasks/service.js";
import type { TaskActor, TaskDetail } from "../../tasks/types.js";
import { jsonText } from "./response.js";
import { toToolError } from "./tool-error.js";

type TaskToolContext = {
  agentId: string;
  /** The caller's project; the default for list and create. */
  projectId: string | null;
  service: TaskService;
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
  structuredContent?: Record<string, unknown>;
};

/** Events `task_get` returns; the board shows the full history. */
const TOOL_EVENT_LIMIT = 30;

function ok(value: object): ToolResult {
  return {
    content: [{ type: "text", text: jsonText(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function toTaskToolError(error: unknown): ToolResult {
  if (error instanceof TaskError) {
    const message =
      error.code === "agent_working"
        ? `${error.message} Tools cannot relaunch over a running agent; leave the task where it is, or ask the user to move it on the board.`
        : error.message;
    return {
      content: [{ type: "text", text: message }],
      isError: true,
      structuredContent: {
        error: { ...(error.code ? { code: error.code } : {}), message },
      },
    };
  }
  return toToolError(error);
}

const linkSchema = z.object({
  kind: z.enum(["pr", "branch", "url"]),
  url: z.string().max(2048).nullable().optional(),
  label: z.string().min(1).max(200),
});

export function registerTaskTools(
  server: McpServer,
  allowed: Set<string>,
  ctx: TaskToolContext
): void {
  const { agentId, service } = ctx;
  const actor: TaskActor = { kind: "agent", agentId };

  const projectFor = (projectId: string | undefined): string => {
    const resolved = projectId ?? ctx.projectId;
    if (!resolved) {
      throw new TaskError(
        "You are not in a project, so there is no default board. Pass projectId.",
        400
      );
    }
    return resolved;
  };

  if (allowed.has("task_list")) {
    server.registerTool(
      "task_list",
      {
        description:
          "List tasks on a project's board (your project by default). Thin rows; task_get has the body, agents and activity.",
        inputSchema: {
          projectId: z.string().min(1).optional(),
          column: z
            .string()
            .min(1)
            .optional()
            .describe("Only tasks in this column (its key, e.g. in_review)."),
          assignedToMe: z
            .boolean()
            .optional()
            .describe("Only tasks assigned to you."),
        },
      },
      async (args) => {
        try {
          const board = await service.getBoard(projectFor(args.projectId));
          const keyOf = new Map(board.columns.map((c) => [c.id, c.key]));
          if (args.column && !board.columns.some((c) => c.key === args.column))
            throw new TaskError(
              `Column "${args.column}" not found. Columns: ${board.columns.map((c) => c.key).join(", ")}.`,
              400
            );
          const tasks = board.tasks
            .filter(
              (t) => !args.column || keyOf.get(t.columnId) === args.column
            )
            .filter((t) => !args.assignedToMe || t.assignedAgentId === agentId)
            .map((t) => ({
              id: t.id,
              title: t.title,
              column: keyOf.get(t.columnId) ?? null,
              assignedAgentId: t.assignedAgentId,
              updatedAt: t.updatedAt,
            }));
          return ok({
            projectId: board.projectId,
            columns: board.columns.map((c) => c.key),
            tasks,
          });
        } catch (error) {
          return toTaskToolError(error);
        }
      }
    );
  }

  if (allowed.has("task_get")) {
    server.registerTool(
      "task_get",
      {
        description:
          "Get a task: body, links, agents that worked it, and its recent activity.",
        inputSchema: { id: z.string().min(1) },
      },
      async (args) => {
        try {
          const detail: TaskDetail = await service.getTaskDetail(
            args.id,
            TOOL_EVENT_LIMIT
          );
          return ok(detail);
        } catch (error) {
          return toTaskToolError(error);
        }
      }
    );
  }

  if (allowed.has("task_create")) {
    server.registerTool(
      "task_create",
      {
        description:
          "Create a task on a project's board (your project by default), in the first column unless you name one. A column with automation may launch an agent for it.",
        inputSchema: {
          title: z.string().min(1).max(500),
          body: z
            .string()
            .max(50_000)
            .optional()
            .describe("Markdown: the deliverable and acceptance criteria."),
          column: z.string().min(1).optional().describe("Column key."),
          projectId: z.string().min(1).optional(),
        },
      },
      async (args) => {
        try {
          const projectId = projectFor(args.projectId);
          const column = args.column
            ? await service.resolveColumnKey(projectId, args.column)
            : null;
          const task = await service.createTask(
            {
              projectId,
              title: args.title,
              ...(args.body !== undefined ? { body: args.body } : {}),
              ...(column ? { columnId: column.id } : {}),
            },
            actor
          );
          const key = (await service.ensureColumns(projectId)).find(
            (c) => c.id === task.columnId
          )?.key;
          return ok({ id: task.id, column: key ?? null });
        } catch (error) {
          return toTaskToolError(error);
        }
      }
    );
  }

  if (allowed.has("task_update")) {
    server.registerTool(
      "task_update",
      {
        description:
          'Update a task. Move it with column (a key) as the work changes state, e.g. "in_review" once a PR is up; a column with automation may launch the next agent. assign "self" makes it yours and opens its conversation in your stream; links are appended.',
        inputSchema: {
          id: z.string().min(1),
          title: z.string().min(1).max(500).optional(),
          body: z.string().max(50_000).optional(),
          column: z.string().min(1).optional().describe("Column key."),
          assign: z.enum(["self", "none"]).optional(),
          links: z
            .array(linkSchema)
            .max(20)
            .optional()
            .describe("Links to add (PRs, branches, docs); deduped by url."),
        },
      },
      async (args) => {
        try {
          const task = await service.requireTask(args.id);
          if (args.assign === "self")
            await service.assignSelf(task.id, agentId);
          const column = args.column
            ? await service.resolveColumnKey(task.projectId, args.column)
            : null;
          const links = args.links
            ? mergeLinks(
                task.links,
                args.links.map((link) => ({
                  kind: link.kind,
                  url: link.url ?? null,
                  label: link.label,
                }))
              ).links
            : undefined;
          const updated = await service.updateTask(
            task.id,
            {
              ...(args.title !== undefined ? { title: args.title } : {}),
              ...(args.body !== undefined ? { body: args.body } : {}),
              ...(column ? { columnId: column.id } : {}),
              ...(links ? { links } : {}),
              ...(args.assign === "none" ? { assignedAgentId: null } : {}),
            },
            actor
          );
          const key = (await service.ensureColumns(updated.projectId)).find(
            (c) => c.id === updated.columnId
          )?.key;
          return ok({
            id: updated.id,
            column: key ?? null,
            assignedAgentId: updated.assignedAgentId,
            links: updated.links,
            latestFailure: updated.latestFailure,
          });
        } catch (error) {
          return toTaskToolError(error);
        }
      }
    );
  }

  if (allowed.has("task_comment")) {
    server.registerTool(
      "task_comment",
      {
        description:
          'Post progress on a task into your conversation thread for it, where the board shows it. Needs an assignment (task_update with assign: "self").',
        inputSchema: {
          id: z.string().min(1),
          text: z.string().min(1).max(20_000),
        },
      },
      async (args) => {
        try {
          return ok(await service.comment(args.id, agentId, args.text));
        } catch (error) {
          return toTaskToolError(error);
        }
      }
    );
  }
}
