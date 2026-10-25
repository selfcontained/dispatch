import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import {
  mergeLinks,
  TaskError,
  type TaskCaller,
  type TaskService,
} from "../../tasks/service.js";
import type { Task, TaskDetail } from "../../tasks/types.js";
import { jsonText } from "./response.js";
import { toToolError } from "./tool-error.js";

type TaskToolContext = {
  /** The calling agent, with its access ceiling for triggered launches. */
  caller: Extract<TaskCaller, { kind: "agent" }>;
  /**
   * The one project these tools act on for this caller: its own, or the
   * project whose repo holds its workspace. Null when there is none.
   */
  resolveProject: () => Promise<string | null>;
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
        ? `${error.message} Tools cannot act over a running agent; leave the task where it is, or ask the user to move it on the board.`
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
  const { caller, service } = ctx;
  const agentId = caller.agentId;

  let scope: Promise<string | null> | null = null;
  /** The caller's project; an explicit `projectId` must name the same one. */
  const projectFor = async (projectId?: string): Promise<string> => {
    scope ??= ctx.resolveProject();
    const own = await scope;
    if (!own) {
      throw new TaskError(
        "You are not in a Dispatch project (no project's repo holds your workspace), so there is no task board for you.",
        400
      );
    }
    if (projectId !== undefined && projectId !== own) {
      throw new TaskError(
        `You can only use the task board of your own project (${own}).`,
        403
      );
    }
    return own;
  };
  /** The task, when it is on the caller's board. */
  const taskInScope = async (id: string): Promise<Task> => {
    const own = await projectFor();
    const task = await service.requireTask(id);
    if (task.projectId !== own) {
      throw new TaskError(
        `Task ${id} belongs to another project; you can only use your own project's tasks.`,
        403
      );
    }
    return task;
  };

  if (allowed.has("task_list")) {
    server.registerTool(
      "task_list",
      {
        description:
          "List tasks on your project's board. Thin rows; task_get has the body, agents and activity.",
        inputSchema: {
          projectId: z.string().min(1).optional(),
          column: z
            .string()
            .min(1)
            .optional()
            .describe("Only tasks in this column (its key, e.g. in_review)."),
          archived: z.boolean().optional().describe("Only archived tasks."),
          assignedToMe: z
            .boolean()
            .optional()
            .describe("Only tasks assigned to you."),
        },
      },
      async (args) => {
        try {
          const board = await service.getBoard(
            await projectFor(args.projectId),
            { archived: args.archived }
          );
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
          "Get a task: its column key, body, links, agents that worked it, and its recent activity.",
        inputSchema: { id: z.string().min(1) },
      },
      async (args) => {
        try {
          await taskInScope(args.id);
          const detail: TaskDetail = await service.getTaskDetail(
            args.id,
            TOOL_EVENT_LIMIT
          );
          const key = (await service.ensureColumns(detail.projectId)).find(
            (c) => c.id === detail.columnId
          )?.key;
          return ok({ ...detail, column: key ?? null });
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
          "Create a task on your project's board, in the first column unless you name one. A column with automation may launch an agent for it.",
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
          const projectId = await projectFor(args.projectId);
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
            caller
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
          "Update fields, move with a column key, append links, or archive/restore. Trigger columns may launch agents; assign self joins the conversation.",
        inputSchema: {
          id: z.string().min(1),
          title: z.string().min(1).max(500).optional(),
          body: z.string().max(50_000).optional(),
          column: z.string().min(1).optional().describe("Column key."),
          archived: z.boolean().optional().describe("Archive or restore."),
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
          const task = await taskInScope(args.id);
          // Resolve everything first; the service then checks and applies
          // the edit, the assignment and the move as one operation.
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
          if (args.archived === false)
            await service.restoreTask(task.id, caller);
          let updated = await service.updateTask(
            task.id,
            {
              ...(args.title !== undefined ? { title: args.title } : {}),
              ...(args.body !== undefined ? { body: args.body } : {}),
              ...(column ? { columnId: column.id } : {}),
              ...(links ? { links } : {}),
              ...(args.assign === "none" ? { assignedAgentId: null } : {}),
            },
            caller,
            { assignSelf: args.assign === "self" }
          );
          if (args.archived === true)
            updated = await service.archiveTask(task.id, caller);
          const key = (await service.ensureColumns(updated.projectId)).find(
            (c) => c.id === updated.columnId
          )?.key;
          return ok({
            id: updated.id,
            archivedAt: updated.archivedAt,
            column: key ?? null,
            assignedAgentId: updated.assignedAgentId,
            links: updated.links,
            latestFailure: updated.latestFailure,
            launching: updated.launching,
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
          "Post on a task's conversation (its own stream, shown on the board) for people; to addresses another agent on the task. Any agent in the task's project may post; posting does not assign you or put you on the task.",
        inputSchema: {
          id: z.string().min(1),
          text: z.string().min(1).max(20_000),
          to: z
            .string()
            .min(1)
            .optional()
            .describe("Another agent on the task to deliver this to."),
        },
      },
      async (args) => {
        try {
          const own = await projectFor();
          const task = await service.requireTask(args.id);
          if (task.projectId !== own) {
            throw new TaskError(
              `You are not in task ${args.id}'s project; only agents in its project post in its conversation.`,
              403
            );
          }
          return ok(
            await service.comment(args.id, agentId, args.text, args.to)
          );
        } catch (error) {
          return toTaskToolError(error);
        }
      }
    );
  }
}
