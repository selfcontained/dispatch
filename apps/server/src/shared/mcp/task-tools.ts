import { taskLabelsSchema } from "../../tasks/labels.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { AGENT_TYPES } from "../../agent-type-settings.js";
import { describeAgentModelCatalog } from "../agent-models.js";

import {
  mergeLinks,
  TaskError,
  type TaskCaller,
  type TaskService,
} from "../../tasks/service.js";
import type { Task, TaskColumn, TaskDetail } from "../../tasks/types.js";
import {
  GOAL_BATCH_MAX,
  GOAL_REQUEST_ID_MAX_LENGTH,
  GOAL_TITLE_MAX_LENGTH,
} from "../../tasks/goals.js";
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

/** Most task ids one `task_list` call may select. */
export const TASK_LIST_IDS_MAX = 50;
/** The row fields `task_list` returns when no `fields` are named. */
const TASK_LIST_DEFAULT_FIELDS = [
  "id",
  "title",
  "column",
  "assignedAgentId",
  "labels",
  "launchTemplateId",
  "updatedAt",
] as const;
const TASK_LIST_FIELDS = [
  ...TASK_LIST_DEFAULT_FIELDS,
  "links",
  "body",
] as const;
type TaskListField = (typeof TASK_LIST_FIELDS)[number];

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
        error: {
          ...(error.code ? { code: error.code } : {}),
          message,
          ...error.extra,
        },
      },
    };
  }
  return toToolError(error);
}

const launchTemplateIdSchema = z
  .string()
  .min(1)
  .nullable()
  .describe(
    "Full task template override for every eligible trigger column; null inherits each column default. Editing does not launch."
  );

const launchAgentTypeSchema = z
  .enum(AGENT_TYPES)
  .nullable()
  .describe(
    "Runtime for this task's trigger launches only; wins over its launch template and column automation without editing either. Needs an explicit launchModel (a stored one is kept if valid for it). Omit to keep; null clears runtime and model to inherit."
  );

// Built per registration: the catalog and its filter change while serving.
const launchModelSchema = () =>
  z
    .string()
    .min(1)
    .nullable()
    .describe(
      "Model for launchAgentType, required with it and validated for that runtime; no default is ever substituted and invalid pairs are rejected with nothing changed. Omit to keep. Null is accepted only with launchAgentType: null (clears the override). " +
        describeAgentModelCatalog(AGENT_TYPES)
    );

const goalTitleSchema = z.string().min(1).max(GOAL_TITLE_MAX_LENGTH);

const requestIdSchema = z
  .string()
  .min(1)
  .max(GOAL_REQUEST_ID_MAX_LENGTH)
  .optional()
  .describe(
    "Any unique string for this write. Retrying with the same requestId returns the first result instead of applying it again."
  );

const linkSchema = z.object({
  kind: z.enum(["pr", "branch", "url"]),
  url: z.string().max(2048).nullable().optional(),
  label: z.string().min(1).max(200),
});

/** The same persisted, resolved metadata in reads and configuration responses. */
function columnMetadata(column: TaskColumn) {
  const {
    id,
    key,
    name,
    position,
    capacity,
    activeTaskCount,
    isDone,
    trigger,
  } = column;
  return {
    id,
    key,
    name,
    position,
    capacity,
    activeTaskCount,
    isDone,
    trigger,
  };
}

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
          "List tasks on your project's board. Thin rows plus ordered column capacities and triggers; task_get has one task's full detail (agents, goals, activity). " +
          "Filters combine (AND). Scan, then batch-read: " +
          `task_list({ columns: ["done", "in_review"], fields: ["id", "title", "column", "links"] }) then task_list({ ids: [...], fields: ["id", "title", "body"] }) (up to ${TASK_LIST_IDS_MAX} ids). ` +
          "Ids not on your board are simply absent.",
        inputSchema: {
          projectId: z.string().min(1).optional(),
          column: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Only tasks in this column (its key, e.g. in_review). Use columns for several; not both."
            ),
          columns: z
            .array(z.string().min(1))
            .min(1)
            .max(50)
            .optional()
            .describe("Only tasks in ANY of these column keys."),
          ids: z
            .array(z.string().min(1).max(200))
            .min(1)
            .max(TASK_LIST_IDS_MAX)
            .optional()
            .describe(
              `Only these task ids (at most ${TASK_LIST_IDS_MAX}). Required to read body.`
            ),
          fields: z
            .array(z.enum(TASK_LIST_FIELDS))
            .min(1)
            .max(TASK_LIST_FIELDS.length)
            .optional()
            .describe(
              "Row fields to return; id is always included. Omit for the default thin row. links works on any list; body needs ids."
            ),
          labels: z
            .array(z.string().trim().min(1).max(40))
            .max(100)
            .optional()
            .describe(
              "Only tasks matching ANY of these project label names (case-insensitive). Omit or [] for all labels; column/global counts are unchanged."
            ),
          archived: z.boolean().optional().describe("Only archived tasks."),
          assignedToMe: z
            .boolean()
            .optional()
            .describe("Only tasks assigned to you."),
        },
      },
      async (args) => {
        try {
          if (args.column !== undefined && args.columns !== undefined)
            throw new TaskError("Pass column or columns, not both.", 400);
          const fields = new Set<TaskListField>(
            args.fields ?? TASK_LIST_DEFAULT_FIELDS
          );
          if (fields.has("body") && !args.ids)
            throw new TaskError(
              `Reading body needs ids (at most ${TASK_LIST_IDS_MAX}); list candidates first, then pass their ids.`,
              400
            );
          const board = await service.getBoard(
            await projectFor(args.projectId),
            {
              archived: args.archived,
              ...(args.ids ? { ids: [...new Set(args.ids)] } : {}),
            }
          );
          const keyOf = new Map(board.columns.map((c) => [c.id, c.key]));
          const columnKeys = new Set(
            args.columns ?? (args.column ? [args.column] : [])
          );
          const unknown = [...columnKeys].filter(
            (key) => !board.columns.some((c) => c.key === key)
          );
          if (unknown.length)
            throw new TaskError(
              `Column${unknown.length > 1 ? "s" : ""} ${unknown.map((key) => `"${key}"`).join(", ")} not found. Columns: ${board.columns.map((c) => c.key).join(", ")}.`,
              400
            );
          const labelNames = new Set(
            (args.labels ?? []).map((name) => name.toLowerCase())
          );
          const row = (t: Task) => {
            const full: Record<TaskListField, unknown> = {
              id: t.id,
              title: t.title,
              column: keyOf.get(t.columnId) ?? null,
              assignedAgentId: t.assignedAgentId,
              labels: t.labels ?? [],
              launchTemplateId: t.launchTemplateId,
              updatedAt: t.updatedAt,
              links: t.links ?? [],
              body: t.body,
            };
            return Object.fromEntries(
              TASK_LIST_FIELDS.filter(
                (field) => field === "id" || fields.has(field)
              ).map((field) => [field, full[field]])
            );
          };
          const tasks = board.tasks
            .filter(
              (t) =>
                !labelNames.size ||
                t.labels?.some((label) =>
                  labelNames.has(label.name.toLowerCase())
                )
            )
            .filter(
              (t) =>
                !columnKeys.size || columnKeys.has(keyOf.get(t.columnId) ?? "")
            )
            .filter((t) => !args.assignedToMe || t.assignedAgentId === agentId)
            .map(row);
          return ok({
            projectId: board.projectId,
            boardWatching: await service.boardWatching(
              board.projectId,
              agentId
            ),
            columns: board.columns.map((c) => c.key),
            columnCapacity: board.columns.map(columnMetadata),
            tasks,
          });
        } catch (error) {
          return toTaskToolError(error);
        }
      }
    );
  }

  if (allowed.has("task_column_update")) {
    server.registerTool(
      "task_column_update",
      {
        description:
          "Configure a column trigger on your project's board by column key. Omit trigger to preserve it, send null to remove it, or send an object to replace it. Configuration never launches agents or moves tasks; future task creation/moves use the existing caller access ceiling. Returns persisted column metadata with the resolved templateName.",
        inputSchema: {
          projectId: z.string().min(1).optional(),
          column: z
            .string()
            .min(1)
            .describe("Column key, e.g. in_review; not a column ID."),
          trigger: z
            .object({
              templateId: z.string().min(1),
              agentType: z
                .enum(AGENT_TYPES)
                .nullable()
                .optional()
                .describe(
                  "Runtime override; omitted or null inherits the template runtime."
                ),
              model: z
                .string()
                .nullable()
                .optional()
                .describe(
                  "Model override; omitted or null inherits the template model. Validated for the effective runtime. " +
                    describeAgentModelCatalog(AGENT_TYPES)
                ),
              effort: z
                .string()
                .min(1)
                .max(128)
                .nullable()
                .optional()
                .describe(
                  "Reasoning effort override: an engine-reported level. Omitted or null inherits the template effort; validated for the effective runtime."
                ),
              assign: z
                .boolean()
                .optional()
                .describe(
                  "Assign the launched agent; defaults to true on replacement."
                ),
              fireOnCreate: z
                .boolean()
                .optional()
                .describe(
                  "Also launch for newly created tasks; defaults to false on replacement."
                ),
            })
            .nullable()
            .optional(),
        },
      },
      async (args) => {
        try {
          const projectId = await projectFor(args.projectId);
          const column = await service.resolveColumnKey(projectId, args.column);
          if (args.trigger !== undefined) {
            await service.updateColumn(column.id, { trigger: args.trigger });
          }
          const board = await service.getBoard(projectId);
          const persisted = board.columns.find((c) => c.id === column.id);
          if (!persisted) throw new TaskError("Column not found.", 404);
          return ok({ projectId, ...columnMetadata(persisted) });
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
          "Get a task: its column key, body, links, ordered goals (id, title, state), agents that worked it, and its recent activity.",
        inputSchema: {
          id: z.string().min(1),
        },
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
          return ok({
            ...detail,
            column: key ?? null,
            watching: await service.watching(args.id, agentId),
          });
        } catch (error) {
          return toTaskToolError(error);
        }
      }
    );
  }

  for (const name of ["task_board_watch", "task_board_unwatch"] as const) {
    if (!allowed.has(name)) continue;
    server.registerTool(
      name,
      {
        description:
          name === "task_board_watch"
            ? "Watch future activity on all tasks in every column of your own project, including newly created tasks. No history replay or assignment. Independent of explicit task watches."
            : "Stop your project board watch; explicit task watches remain active.",
        inputSchema: { projectId: z.string().min(1).optional() },
      },
      async ({ projectId: requested }) => {
        try {
          const projectId = await projectFor(requested);
          if (name === "task_board_watch")
            await service.watchBoard(projectId, agentId);
          else await service.unwatchBoard(projectId, agentId);
          return ok({ projectId, watching: name === "task_board_watch" });
        } catch (error) {
          return toTaskToolError(error);
        }
      }
    );
  }

  for (const name of ["task_watch", "task_unwatch"] as const) {
    if (!allowed.has(name)) continue;
    server.registerTool(
      name,
      {
        description:
          name === "task_watch"
            ? "Watch task activity and new conversation posts without taking assignment."
            : "Stop watching a task.",
        inputSchema: { id: z.string().min(1) },
      },
      async ({ id }) => {
        try {
          await taskInScope(id);
          if (name === "task_watch") await service.watch(id, agentId);
          else await service.unwatch(id, agentId);
          return ok({ id, watching: name === "task_watch" });
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
          labels: taskLabelsSchema
            .optional()
            .describe(
              "Project label assignments. Replaces the task's labels; omit on update to preserve. Send [] to remove all, or send remaining labels to remove one. Names reuse project definitions/colors; new names must be 16 characters or fewer. Existing longer names remain usable."
            ),
          launchTemplateId: launchTemplateIdSchema.optional(),
          launchAgentType: launchAgentTypeSchema.optional(),
          launchModel: launchModelSchema().optional(),
          title: z.string().min(1).max(500),
          body: z
            .string()
            .max(50_000)
            .optional()
            .describe("Markdown: the deliverable and acceptance criteria."),
          column: z.string().min(1).optional().describe("Column key."),
          projectId: z.string().min(1).optional(),
          goals: z
            .array(goalTitleSchema)
            .max(GOAL_BATCH_MAX)
            .optional()
            .describe(
              "Short titles of the task's verifiable outcomes, in order. They exist before any launch and show as progress on the board."
            ),
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
              ...(args.launchTemplateId !== undefined
                ? { launchTemplateId: args.launchTemplateId }
                : {}),
              ...(args.launchAgentType !== undefined
                ? { launchAgentType: args.launchAgentType }
                : {}),
              ...(args.launchModel !== undefined
                ? { launchModel: args.launchModel }
                : {}),
              title: args.title,
              ...(args.labels !== undefined ? { labels: args.labels } : {}),
              ...(args.body !== undefined ? { body: args.body } : {}),
              ...(column ? { columnId: column.id } : {}),
              ...(args.goals?.length ? { goals: args.goals } : {}),
            },
            caller
          );
          const key = (await service.ensureColumns(projectId)).find(
            (c) => c.id === task.columnId
          )?.key;
          const goals = args.goals?.length
            ? (await service.getTaskDetail(task.id, 0)).goals.map(
                ({ id, title, state }) => ({ id, title, state })
              )
            : [];
          return ok({
            id: task.id,
            column: key ?? null,
            goals,
            labels: task.labels ?? [],
            launchTemplateId: task.launchTemplateId,
            launchAgentType: task.launchAgentType,
            launchModel: task.launchModel,
          });
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
          'Update a task. Move it with column (a key) as the work changes state, e.g. "in_review" once a PR is up (your task briefing lists this board\'s keys); a column with automation may launch the next agent. assign "self" makes it yours and puts you on its conversation (the task\'s own stream); links are appended; archived (sent alone) archives or restores it.',
        inputSchema: {
          id: z.string().min(1),
          labels: taskLabelsSchema
            .optional()
            .describe(
              "Project label assignments. Replaces the task's labels; omit on update to preserve. Send [] to remove all, or send remaining labels to remove one. Names reuse project definitions/colors; new names must be 16 characters or fewer. Existing longer names remain usable."
            ),
          launchTemplateId: launchTemplateIdSchema.optional(),
          launchAgentType: launchAgentTypeSchema.optional(),
          launchModel: launchModelSchema().optional(),
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
          // Archive/restore is its own operation so a refused edit, assignment
          // or move can never leave a half-applied restore behind.
          if (args.archived !== undefined) {
            const { id: _id, archived, ...rest } = args;
            if (Object.values(rest).some((value) => value !== undefined))
              throw new TaskError(
                "Send archived on its own; restore first, then update the task.",
                400
              );
            const updated = archived
              ? await service.archiveTask(task.id, caller)
              : await service.restoreTask(task.id, caller);
            return ok({ id: updated.id, archivedAt: updated.archivedAt });
          }
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
          const updated = await service.updateTask(
            task.id,
            {
              ...(args.launchTemplateId !== undefined
                ? { launchTemplateId: args.launchTemplateId }
                : {}),
              ...(args.launchAgentType !== undefined
                ? { launchAgentType: args.launchAgentType }
                : {}),
              ...(args.launchModel !== undefined
                ? { launchModel: args.launchModel }
                : {}),
              ...(args.title !== undefined ? { title: args.title } : {}),
              ...(args.labels !== undefined ? { labels: args.labels } : {}),
              ...(args.body !== undefined ? { body: args.body } : {}),
              ...(column ? { columnId: column.id } : {}),
              ...(links ? { links } : {}),
              ...(args.assign === "none" ? { assignedAgentId: null } : {}),
            },
            caller,
            { assignSelf: args.assign === "self" }
          );
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
            labels: updated.labels ?? [],
            launchTemplateId: updated.launchTemplateId,
            launchAgentType: updated.launchAgentType,
            launchModel: updated.launchModel,
          });
        } catch (error) {
          return toTaskToolError(error);
        }
      }
    );
  }

  const goalsResult = (result: Awaited<ReturnType<TaskService["addGoals"]>>) =>
    ok({
      taskId: result.taskId,
      goals: result.goals.map(({ id, title, state }) => ({ id, title, state })),
      goalCounts: result.goalCounts,
      changes: result.changes,
      ...(result.replayed ? { replayed: true } : {}),
    });

  if (allowed.has("task_goal_add")) {
    server.registerTool(
      "task_goal_add",
      {
        description:
          "Append goals to a task: short titles of verifiable outcomes, in order. A title matching a current goal is skipped. Returns every goal with its id and state.",
        inputSchema: {
          id: z.string().min(1).describe("Task id."),
          titles: z.array(goalTitleSchema).min(1).max(GOAL_BATCH_MAX),
          requestId: requestIdSchema,
        },
      },
      async (args) => {
        try {
          await taskInScope(args.id);
          return goalsResult(
            await service.addGoals(args.id, args.titles, caller, {
              requestId: args.requestId,
            })
          );
        } catch (error) {
          return toTaskToolError(error);
        }
      }
    );
  }

  if (allowed.has("task_goal_update")) {
    server.registerTool(
      "task_goal_update",
      {
        description:
          "Change a task's goals by id (from task_get): rename with title, and/or action complete, reopen or retire. Retired goals leave the progress count. The batch applies all or nothing; repeating an edit already in effect changes nothing. Returns every goal with its state. Goals never move the task between columns.",
        inputSchema: {
          id: z.string().min(1).describe("Task id."),
          changes: z
            .array(
              z.object({
                goalId: z.string().min(1),
                title: goalTitleSchema.optional(),
                action: z.enum(["complete", "reopen", "retire"]).optional(),
              })
            )
            .min(1)
            .max(GOAL_BATCH_MAX),
          requestId: requestIdSchema,
        },
      },
      async (args) => {
        try {
          await taskInScope(args.id);
          return goalsResult(
            await service.editGoals(args.id, args.changes, caller, {
              requestId: args.requestId,
            })
          );
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
