import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { JobTools } from "./job-tools.js";
import { jsonText } from "./response.js";
import { toToolError } from "./tool-error.js";

export type AnalyticsCallbacks = Partial<
  Pick<
    JobTools,
    "getActivitySummary" | "getAgentHistory" | "getFeedbackSummary"
  >
>;

export function registerAnalyticsTools(
  server: McpServer,
  allowed: Set<string>,
  callbacks: AnalyticsCallbacks
): void {
  if (allowed.has("get_activity_summary") && callbacks.getActivitySummary) {
    const fn = callbacks.getActivitySummary;
    server.registerTool(
      "get_activity_summary",
      {
        description:
          "Get a high-level summary of agent activity in Dispatch over a time range — working time, session counts, outcomes, and top agents by project. Use this for activity digests and dashboards.",
        inputSchema: {
          start: z
            .string()
            .datetime({ offset: true })
            .optional()
            .describe(
              "Start of time range (ISO 8601 with timezone). Defaults to 7 days ago."
            ),
          end: z
            .string()
            .datetime({ offset: true })
            .optional()
            .describe(
              "End of time range (ISO 8601 with timezone). Defaults to now."
            ),
          project: z
            .string()
            .optional()
            .describe(
              "Filter to a specific project directory (exact match). If omitted, returns all projects."
            ),
        },
      },
      async (args) => {
        try {
          const end = args.end ? new Date(args.end) : new Date();
          const start = args.start
            ? new Date(args.start)
            : new Date(end.getTime() - 7 * 86_400_000);
          if (start >= end)
            return toToolError(new Error("start must be before end"));
          const result = await fn({ start, end, project: args.project });
          return {
            content: [{ type: "text", text: jsonText(result) }],
            structuredContent: result,
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  if (allowed.has("get_agent_history") && callbacks.getAgentHistory) {
    const fn = callbacks.getAgentHistory;
    server.registerTool(
      "get_agent_history",
      {
        description:
          "Get detailed agent session history — what agents worked on, their event timelines, feedback received, and review results. Use for deeper investigation after get_activity_summary or for building narrative summaries.",
        inputSchema: {
          start: z
            .string()
            .datetime({ offset: true })
            .optional()
            .describe(
              "Start of time range (ISO 8601 with timezone). Defaults to 7 days ago."
            ),
          end: z
            .string()
            .datetime({ offset: true })
            .optional()
            .describe(
              "End of time range (ISO 8601 with timezone). Defaults to now."
            ),
          project: z
            .string()
            .optional()
            .describe("Filter to a specific project directory (exact match)."),
          limit: z
            .number()
            .int()
            .min(1)
            .max(50)
            .default(20)
            .describe(
              "Max number of agent sessions to return (default 20, max 50)."
            ),
          offset: z
            .number()
            .int()
            .min(0)
            .default(0)
            .describe("Pagination offset."),
          include_events: z
            .boolean()
            .default(false)
            .describe(
              "Include the event timeline for each agent session (capped at 200 per agent). Can be verbose."
            ),
          include_feedback: z
            .boolean()
            .default(true)
            .describe("Include feedback findings for each agent session."),
          include_reviews: z
            .boolean()
            .default(true)
            .describe(
              "Include persona review summaries for each agent session."
            ),
          include_children: z
            .boolean()
            .default(false)
            .describe(
              "Include child/persona agents as standalone entries (default: nested under parent)."
            ),
        },
      },
      async (args) => {
        try {
          const end = args.end ? new Date(args.end) : new Date();
          const start = args.start
            ? new Date(args.start)
            : new Date(end.getTime() - 7 * 86_400_000);
          if (start >= end)
            return toToolError(new Error("start must be before end"));
          const result = await fn({
            start,
            end,
            project: args.project,
            limit: args.limit,
            offset: args.offset,
            includeEvents: args.include_events,
            includeFeedback: args.include_feedback,
            includeReviews: args.include_reviews,
            includeChildren: args.include_children,
          });
          return {
            content: [{ type: "text", text: jsonText(result) }],
            structuredContent: result,
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  if (allowed.has("get_feedback_summary") && callbacks.getFeedbackSummary) {
    const fn = callbacks.getFeedbackSummary;
    server.registerTool(
      "get_feedback_summary",
      {
        description:
          "Aggregate review feedback to surface patterns — recurring issue types and hot spots in the codebase. Use for feedback pattern tracking and coaching check-ins.",
        inputSchema: {
          start: z
            .string()
            .datetime({ offset: true })
            .optional()
            .describe(
              "Start of time range (ISO 8601 with timezone). Defaults to 14 days ago."
            ),
          end: z
            .string()
            .datetime({ offset: true })
            .optional()
            .describe(
              "End of time range (ISO 8601 with timezone). Defaults to now."
            ),
          project: z
            .string()
            .optional()
            .describe("Filter to a specific project directory (exact match)."),
          group_by: z
            .enum(["persona", "severity", "directory"])
            .default("persona")
            .describe("Primary grouping for the summary."),
        },
      },
      async (args) => {
        try {
          const end = args.end ? new Date(args.end) : new Date();
          const start = args.start
            ? new Date(args.start)
            : new Date(end.getTime() - 14 * 86_400_000);
          if (start >= end)
            return toToolError(new Error("start must be before end"));
          const result = await fn({
            start,
            end,
            project: args.project,
            groupBy: args.group_by,
          });
          return {
            content: [{ type: "text", text: jsonText(result) }],
            structuredContent: result,
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }
}
