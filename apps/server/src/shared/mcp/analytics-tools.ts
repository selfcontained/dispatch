import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { JobTools } from "./job-tools.js";
import { jsonText } from "./response.js";
import { toToolError } from "./tool-error.js";

export type AnalyticsCallbacks = Partial<
  Pick<JobTools, "getActivitySummary" | "getFeedbackSummary">
>;

/**
 * A summary answers "where are the patterns"; the finding descriptions behind
 * each group are the bulk of the payload (85% of it on a small dataset, and
 * they grow with the corpus) and are only wanted for the one group a caller is
 * digging into. So the default response omits them — reporting the group's own
 * `distinctFindings` count, which the aggregate computes before topFindings is
 * capped — and naming a group in `group` returns that group's findings.
 *
 * Both helpers take the callback's `Record<string, unknown>` at face value, so
 * they validate rather than assume: a result without a well-formed `groups`
 * array is an error the caller can see, not a silently empty response.
 */
function readGroups(
  result: Record<string, unknown>
): Array<Record<string, unknown>> | null {
  const groups = result.groups;
  if (!Array.isArray(groups)) return null;
  if (
    !groups.every(
      (group) =>
        group !== null && typeof group === "object" && !Array.isArray(group)
    )
  ) {
    return null;
  }
  return groups as Array<Record<string, unknown>>;
}

function toGroupSummary(
  result: Record<string, unknown>,
  groups: Array<Record<string, unknown>>
): Record<string, unknown> {
  return {
    ...result,
    groups: groups.map(({ topFindings: _topFindings, ...rest }) => rest),
  };
}

function selectGroup(
  result: Record<string, unknown>,
  groups: Array<Record<string, unknown>>,
  key: string
): Record<string, unknown> | null {
  const match = groups.find((group) => group.key === key);
  if (!match) return null;
  const { groups: _groups, ...context } = result;
  return { ...context, group: match };
}

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

  if (allowed.has("get_feedback_summary") && callbacks.getFeedbackSummary) {
    const fn = callbacks.getFeedbackSummary;
    server.registerTool(
      "get_feedback_summary",
      {
        description:
          "Aggregate review feedback to surface patterns — recurring issue types and hot spots in the codebase. Use for feedback pattern tracking and coaching check-ins. " +
          "Each group reports its `distinctFindings` count rather than the finding text; pass `group` with a group's key to get that group's most common findings (top 5).",
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
          group: z
            .string()
            .optional()
            .describe(
              "Return this one group's findings in full instead of the counts-only summary. Use a `key` from a previous call."
            ),
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
          const groups = readGroups(result);
          if (!groups) {
            return toToolError(
              new Error("Feedback summary came back without usable groups.")
            );
          }
          if (args.group !== undefined) {
            const detail = selectGroup(result, groups, args.group);
            if (!detail) {
              const keys = groups
                .map((group) => group.key)
                .filter((key): key is string => typeof key === "string");
              return toToolError(
                new Error(
                  `No group "${args.group}" in this ${args.group_by} summary. Available: ${
                    keys.length > 0 ? keys.join(", ") : "(none)"
                  }.`
                )
              );
            }
            return {
              content: [{ type: "text", text: jsonText(detail) }],
              structuredContent: detail,
            };
          }
          const summary = toGroupSummary(result, groups);
          return {
            content: [{ type: "text", text: jsonText(summary) }],
            structuredContent: summary,
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }
}
