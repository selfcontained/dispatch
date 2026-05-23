import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { McpRequestContext } from "./server.js";
import { toToolError } from "./tool-error.js";

export type PersonaToolCallbacks = {
  agentId: string;
  parentAgentId?: string | null;
  updateReviewStatus?: McpRequestContext["updateReviewStatus"];
  completeReview?: McpRequestContext["completeReview"];
  getParentContext?: McpRequestContext["getParentContext"];
  getRecheckContext?: McpRequestContext["getRecheckContext"];
  cancelRecheck?: McpRequestContext["cancelRecheck"];
};

export function registerPersonaTools(
  server: McpServer,
  allowed: Set<string>,
  callbacks: PersonaToolCallbacks
): void {
  const { agentId } = callbacks;

  // ── review_status (persona) ───────────────────────────────────────
  if (allowed.has("review_status") && callbacks.updateReviewStatus) {
    const updateReviewStatus = callbacks.updateReviewStatus;

    server.registerTool(
      "review_status",
      {
        description:
          "Reviewer-only. Ping review progress while you work — pass a short `message` describing your current activity. Call this at review start and at meaningful phase changes (e.g. 'Reading diff', 'Running tests'). Do NOT use this to complete the review; use `dispatch_complete_review` for that.",
        inputSchema: {
          message: z
            .string()
            .describe("Short description of current activity."),
        },
      },
      async (args) => {
        try {
          await updateReviewStatus(agentId, {
            status: "reviewing",
            message: args.message,
          });
          return {
            content: [{ type: "text", text: `Reviewing: ${args.message}` }],
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  if (allowed.has("dispatch_complete_review") && callbacks.completeReview) {
    const completeReview = callbacks.completeReview;

    server.registerTool(
      "dispatch_complete_review",
      {
        description:
          "Reviewer-only. Complete the current review round with a verdict and summary. Valid from round 1 ('reviewing') and round 2 ('awaiting_recheck'). A third completion is rejected in v1.",
        inputSchema: {
          verdict: z
            .enum(["approve", "request_changes"])
            .describe("Review verdict for this round."),
          summary: z
            .string()
            .min(1)
            .describe("Summary of the review findings for this round."),
          filesReviewed: z
            .array(z.string())
            .optional()
            .describe("List of file paths reviewed in this round."),
          message: z
            .string()
            .optional()
            .describe("Optional short status note to store with the review."),
        },
      },
      async (args) => {
        try {
          await completeReview(agentId, {
            verdict: args.verdict,
            summary: args.summary,
            filesReviewed: args.filesReviewed,
            message: args.message,
          });
          return {
            content: [
              {
                type: "text",
                text: `Review complete: ${args.verdict}. ${args.summary}`,
              },
            ],
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  // ── get_parent_context (persona) ────────────────────────────────────
  if (
    allowed.has("get_parent_context") &&
    callbacks.parentAgentId &&
    callbacks.getParentContext
  ) {
    const parentAgentId = callbacks.parentAgentId;
    const getParentContext = callbacks.getParentContext;

    server.registerTool(
      "get_parent_context",
      {
        description:
          "Retrieve the parent agent's pins and shared media. Use this to discover dev server URLs, " +
          "key files, screenshots, and other context the parent agent has surfaced. Each shared media " +
          "item includes an absolute filePath and sizeBytes so you can open or inspect the artifact directly.",
        inputSchema: {},
      },
      async () => {
        try {
          const result = await getParentContext(parentAgentId);
          const parts: string[] = [];
          if (result.pins.length > 0) {
            parts.push("Pins:");
            for (const pin of result.pins) {
              parts.push(`  ${pin.label} (${pin.type}): ${pin.value}`);
            }
          } else {
            parts.push("No pins set by parent agent.");
          }
          if (result.media.length > 0) {
            parts.push("\nShared media:");
            for (const m of result.media) {
              parts.push(
                `  ${m.fileName} (${m.sizeBytes} bytes) at ${m.filePath}: ${m.description ?? "(no description)"}`
              );
            }
          }
          return {
            content: [{ type: "text", text: parts.join("\n") }],
            structuredContent: result,
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  // ── dispatch_get_recheck_context (persona) ────────────────────────
  if (
    allowed.has("dispatch_get_recheck_context") &&
    callbacks.getRecheckContext
  ) {
    const getRecheckContext = callbacks.getRecheckContext;

    server.registerTool(
      "dispatch_get_recheck_context",
      {
        description:
          "Reviewer-only. Returns whether round-2 context is ready yet and, once it is, the parent's resolution summary, per-item resolutions, and the exact commit range to inspect locally with git diff.",
        inputSchema: {},
      },
      async () => {
        try {
          const result = await getRecheckContext(agentId);
          if (!result) {
            throw new Error("No recheck context is available for this review.");
          }
          const compareText =
            result.availability === "ready"
              ? result.compareRange
                ? `Inspect ${result.compareRange}.`
                : "Round 2 is ready, but no compare range is available for this recheck."
              : result.availability === "waiting_for_resolution"
                ? "Round 2 is not ready yet. Wait for the parent's resolution prompt."
                : result.availability === "cancelled"
                  ? "This recheck was cancelled by the parent."
                  : "This recheck is already complete.";
          return {
            content: [{ type: "text", text: compareText }],
            structuredContent: result,
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  if (allowed.has("dispatch_cancel_recheck") && callbacks.cancelRecheck) {
    const cancelRecheck = callbacks.cancelRecheck;

    server.registerTool(
      "dispatch_cancel_recheck",
      {
        description:
          "Parent-only. Cancel a pending recheck loop so the reviewer exits cleanly on its next poll. Rejected after round 2 is already complete.",
        inputSchema: {
          personaAgentId: z
            .string()
            .describe(
              "The persona agent ID whose recheck should be cancelled."
            ),
          reason: z
            .string()
            .max(10_000)
            .optional()
            .describe("Optional reason surfaced to the reviewer."),
        },
      },
      async (args) => {
        try {
          await cancelRecheck(agentId, {
            personaAgentId: args.personaAgentId,
            reason: args.reason,
          });
          return {
            content: [
              {
                type: "text",
                text: `Cancelled recheck for persona agent ${args.personaAgentId}.`,
              },
            ],
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }
}
