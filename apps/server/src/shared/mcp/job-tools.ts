import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import { jsonText } from "./response.js";
import { toToolError } from "./tool-error.js";

export type JobTools = {
  complete: (
    agentId: string,
    report: unknown
  ) => Promise<{ runId: string; status: string }>;
  failed: (
    agentId: string,
    report: unknown
  ) => Promise<{ runId: string; status: string }>;
  needsInput: (
    agentId: string,
    question: string
  ) => Promise<{ runId: string; status: string }>;
  log: (
    agentId: string,
    input: {
      task: string;
      message: string;
      level: "debug" | "info" | "warn" | "error";
    }
  ) => Promise<{ runId: string; status: string }>;
  listAgents: () => Promise<
    Array<{ id: string; name: string; status: string; cwd: string }>
  >;
  getActivitySummary: (params: {
    start: Date;
    end: Date;
    project?: string;
  }) => Promise<Record<string, unknown>>;
  getFeedbackSummary: (params: {
    start: Date;
    end: Date;
    project?: string;
    groupBy: "persona" | "severity" | "directory";
  }) => Promise<Record<string, unknown>>;
};

export function registerJobTools(
  server: McpServer,
  agentId: string,
  jobTools: JobTools
): void {
  const reportSchema = z.object({
    status: z.enum(["completed", "failed"]),
    summary: z.string().min(1),
    tasks: z.array(
      z.object({
        name: z.string().min(1),
        status: z.enum(["success", "skipped", "error"]),
        summary: z.string(),
        errors: z
          .array(
            z.object({
              message: z.string().min(1),
              recoverable: z.boolean().optional(),
              action: z.string().optional(),
            })
          )
          .optional(),
      })
    ),
    continuation: z
      .object({
        action: z
          .enum(["default", "continue", "pause", "finish"])
          .default("default")
          .describe(
            "Whether the Loop should start another run, pause, or finish. Default continues when more runs are allowed."
          ),
        phase: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("Optional short name for the current phase of work."),
        summary: z
          .string()
          .min(1)
          .max(4000)
          .optional()
          .describe("Optional compact handoff summary for the next run."),
        nextIntent: z
          .string()
          .min(1)
          .max(4000)
          .optional()
          .describe(
            "What the next run should do first. Required when the Loop will continue."
          ),
        filePaths: z
          .array(z.string().min(1).max(1000))
          .max(50)
          .optional()
          .describe(
            "Files or directories containing context relevant to the next run."
          ),
        blockers: z
          .array(z.string().min(1).max(1000))
          .max(50)
          .optional()
          .describe("Unresolved blockers the next run must know about."),
      })
      .optional()
      .describe(
        "Run-to-run handoff for Loop jobs. Dispatch stores it and gives it to the successor run."
      ),
  });

  server.registerTool(
    "job_complete",
    {
      description:
        "Submit the terminal structured report for a successful Dispatch job run.",
      inputSchema: {
        report: reportSchema.describe(
          "Structured job report. report.status must be completed."
        ),
      },
    },
    async (args) => {
      try {
        const result = await jobTools.complete(agentId, args.report);
        return {
          content: [
            {
              type: "text",
              text: `Job run ${result.runId} marked ${result.status}.`,
            },
          ],
          structuredContent: result,
        };
      } catch (error) {
        return toToolError(error);
      }
    }
  );

  server.registerTool(
    "job_failed",
    {
      description:
        "Submit the terminal structured report for a failed Dispatch job run.",
      inputSchema: {
        report: reportSchema.describe(
          "Structured job report. report.status must be failed."
        ),
      },
    },
    async (args) => {
      try {
        const result = await jobTools.failed(agentId, args.report);
        return {
          content: [
            {
              type: "text",
              text: `Job run ${result.runId} marked ${result.status}.`,
            },
          ],
          structuredContent: result,
        };
      } catch (error) {
        return toToolError(error);
      }
    }
  );

  server.registerTool(
    "job_needs_input",
    {
      description: "Pause a Dispatch job run when human input is required.",
      inputSchema: {
        question: z
          .string()
          .min(1)
          .describe("The question or decision needed from a human."),
      },
    },
    async (args) => {
      try {
        const result = await jobTools.needsInput(agentId, args.question);
        return {
          content: [
            {
              type: "text",
              text: `Job run ${result.runId} marked ${result.status}.`,
            },
          ],
          structuredContent: result,
        };
      } catch (error) {
        return toToolError(error);
      }
    }
  );

  server.registerTool(
    "job_log",
    {
      description:
        "Append structured progress for a task within the active Dispatch job run.",
      inputSchema: {
        task: z
          .string()
          .min(1)
          .describe("Task name this log entry belongs to."),
        message: z.string().min(1).describe("Progress message."),
        level: z
          .enum(["debug", "info", "warn", "error"])
          .default("info")
          .describe("Log severity."),
      },
    },
    async (args) => {
      try {
        const result = await jobTools.log(agentId, args);
        return {
          content: [
            {
              type: "text",
              text: `Logged progress for job run ${result.runId}.`,
            },
          ],
          structuredContent: result,
        };
      } catch (error) {
        return toToolError(error);
      }
    }
  );

  server.registerTool(
    "list_agents",
    {
      description:
        "List all agents from this Dispatch server with their IDs, names, and statuses.",
      inputSchema: {},
    },
    async () => {
      try {
        const agents = await jobTools.listAgents();
        return {
          content: [{ type: "text", text: jsonText({ agents }) }],
          structuredContent: { agents },
        };
      } catch (error) {
        return toToolError(error);
      }
    }
  );
}
