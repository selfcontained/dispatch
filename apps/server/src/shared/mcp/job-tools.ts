import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

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
  listRecentPersonaReviews: (sinceDays: number) => Promise<
    Array<{
      id: number;
      agentId: string;
      parentAgentId: string;
      persona: string;
      status: string;
      message: string | null;
      verdict: string | null;
      summary: string | null;
      filesReviewed: string[] | null;
      createdAt: string;
      updatedAt: string;
    }>
  >;
  listRecentFeedback: (sinceDays: number) => Promise<
    Array<{
      id: number;
      agentId: string;
      persona: string;
      severity: string;
      filePath: string | null;
      lineNumber: number | null;
      description: string;
      suggestion: string | null;
      mediaRef: string | null;
      status: string;
      createdAt: string;
    }>
  >;
  getActivitySummary: (params: {
    start: Date;
    end: Date;
    project?: string;
  }) => Promise<Record<string, unknown>>;
  getAgentHistory: (params: {
    start: Date;
    end: Date;
    project?: string;
    limit: number;
    offset: number;
    includeEvents: boolean;
    includeFeedback: boolean;
    includeReviews: boolean;
    includeChildren: boolean;
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
          content: [
            { type: "text", text: JSON.stringify({ agents }, null, 2) },
          ],
          structuredContent: { agents },
        };
      } catch (error) {
        return toToolError(error);
      }
    }
  );

  server.registerTool(
    "list_recent_persona_reviews",
    {
      description:
        "List persona reviews from the last N days. Returns review metadata including persona type, status, verdict, and summary.",
      inputSchema: {
        since_days: z
          .number()
          .int()
          .min(1)
          .max(90)
          .default(7)
          .describe("Number of days to look back (default 7, max 90)."),
      },
    },
    async (args) => {
      try {
        const reviews = await jobTools.listRecentPersonaReviews(
          args.since_days
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ reviews, count: reviews.length }, null, 2),
            },
          ],
          structuredContent: { reviews, count: reviews.length },
        };
      } catch (error) {
        return toToolError(error);
      }
    }
  );

  server.registerTool(
    "list_recent_feedback",
    {
      description:
        "List feedback items submitted by persona agents in the last N days. Includes persona type, severity, description, status, and file location.",
      inputSchema: {
        since_days: z
          .number()
          .int()
          .min(1)
          .max(90)
          .default(7)
          .describe("Number of days to look back (default 7, max 90)."),
      },
    },
    async (args) => {
      try {
        const feedback = await jobTools.listRecentFeedback(args.since_days);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { feedback, count: feedback.length },
                null,
                2
              ),
            },
          ],
          structuredContent: { feedback, count: feedback.length },
        };
      } catch (error) {
        return toToolError(error);
      }
    }
  );
}
