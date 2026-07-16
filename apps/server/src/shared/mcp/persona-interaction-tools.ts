import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import {
  AGENT_REVIEW_REPLY_GUIDANCE,
  AGENT_REVIEW_REPLY_MAX_CHARS,
} from "../review-limits.js";

import { mergePersonasWithWorktreePrecedence } from "../../personas/loader.js";
import type { McpRequestContext } from "./server.js";
import { toToolError } from "./tool-error.js";

export const LAUNCH_PERSONA_AGENT_TYPES = [
  "claude",
  "codex",
  "cursor",
  "opencode",
] as const;
export type LaunchPersonaAgentType =
  (typeof LAUNCH_PERSONA_AGENT_TYPES)[number];

export type PersonaInteractionCallbacks = {
  agentId: string;
  worktreeRoot?: string | null;
  repoRoot?: string | null;
  listPersonas?: McpRequestContext["listPersonas"];
  launchPersona?: McpRequestContext["launchPersona"];
  getFeedback?: McpRequestContext["getFeedback"];
  resolveFeedback?: McpRequestContext["resolveFeedback"];
  resolveReviewFeedback?: McpRequestContext["resolveReviewFeedback"];
  reopenReviewFeedback?: McpRequestContext["reopenReviewFeedback"];
  submitReview?: McpRequestContext["submitReview"];
  addReviewFeedback?: McpRequestContext["addReviewFeedback"];
  addReviewThreadMessage?: McpRequestContext["addReviewThreadMessage"];
  listReviewFeedback?: McpRequestContext["listReviewFeedback"];
  submitResolution?: McpRequestContext["submitResolution"];
};

type PersonaSummary = { slug: string; name: string; description: string };

export async function resolvePersonaList(
  listPersonas: (root: string) => Promise<PersonaSummary[]>,
  worktreeRoot?: string | null,
  repoRoot?: string | null
): Promise<PersonaSummary[]> {
  const worktreePersonas = worktreeRoot
    ? await listPersonas(worktreeRoot).catch(() => [])
    : [];
  const repoPersonas =
    repoRoot && repoRoot !== worktreeRoot
      ? await listPersonas(repoRoot).catch(() => [])
      : [];

  return mergePersonasWithWorktreePrecedence({
    worktreePersonas,
    repoPersonas,
  });
}

export function registerPersonaInteractionTools(
  server: McpServer,
  allowed: Set<string>,
  callbacks: PersonaInteractionCallbacks
): void {
  const { agentId } = callbacks;

  const feedbackItemSchema = {
    filePath: z.string().optional().describe("Repo-relative file path."),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    comment: z.string().min(1).max(10_000),
  };

  if (allowed.has("dispatch_review_submit") && callbacks.submitReview) {
    const submitReview = callbacks.submitReview;
    server.registerTool(
      "dispatch_review_submit",
      {
        description:
          "Submit this reviewer's completed initial pass. Creates one agent-authored review assigned to the parent agent. `summary` is always required. `feedback` may be empty for a clean approval; that still creates a resolved review record with the summary.",
        inputSchema: {
          summary: z.string().min(1).max(10_000),
          feedback: z.array(z.object(feedbackItemSchema)).max(100).default([]),
        },
      },
      async (args) => {
        try {
          const result = await submitReview(agentId, args);
          const count = result.review.items.length;
          return {
            content: [
              {
                type: "text",
                text:
                  count === 0
                    ? `Review #${result.review.id} submitted as a clean approval.`
                    : `Review #${result.review.id} submitted with ${count} feedback item(s).`,
              },
            ],
            structuredContent: result,
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  if (
    allowed.has("dispatch_review_add_feedback") &&
    callbacks.addReviewFeedback
  ) {
    const addReviewFeedback = callbacks.addReviewFeedback;
    server.registerTool(
      "dispatch_review_add_feedback",
      {
        description:
          "Add one genuinely new concern to a review already submitted by this reviewer. Use dispatch_review_add_message instead when continuing an existing concern.",
        inputSchema: {
          reviewId: z.number().int().positive(),
          ...feedbackItemSchema,
        },
      },
      async (args) => {
        try {
          const result = await addReviewFeedback(agentId, args);
          return {
            content: [
              {
                type: "text",
                text: `Feedback item #${result.item.id} added to review #${args.reviewId}. Review status: ${result.reviewStatus}.`,
              },
            ],
            structuredContent: result,
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  // ── list_personas ────────────────────────────────────────────────
  if (allowed.has("list_personas") && callbacks.listPersonas) {
    const listPersonas = callbacks.listPersonas;
    const { worktreeRoot, repoRoot } = callbacks;

    server.registerTool(
      "list_personas",
      {
        description:
          "List the persona reviewers available for this project. Returns each persona's slug, name, and description. Use this to decide which personas to launch via dispatch_launch_persona.",
        inputSchema: {},
      },
      async () => {
        try {
          const personas = await resolvePersonaList(
            listPersonas,
            worktreeRoot,
            repoRoot
          );
          return {
            content: [
              { type: "text", text: JSON.stringify({ personas }, null, 2) },
            ],
            structuredContent: { personas },
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  // ── dispatch_launch_persona ───────────────────────────────────────
  if (allowed.has("dispatch_launch_persona") && callbacks.launchPersona) {
    const launchPersona = callbacks.launchPersona;

    server.registerTool(
      "dispatch_launch_persona",
      {
        description:
          "Launch a persona agent to review or test your current work. The persona runs in your working directory with specialized instructions and submits one tracked review through dispatch_review_submit. Findings and follow-up discussion use review feedback item threads.",
        inputSchema: {
          persona: z
            .string()
            .describe(
              "Name of the persona to launch (matches filename without .md extension, e.g. 'security-review')."
            ),
          context: z
            .string()
            .max(100_000)
            .describe(
              "Briefing for the persona — describe what you built, key files changed, and areas that need attention."
            ),
          agentType: z
            .enum(LAUNCH_PERSONA_AGENT_TYPES)
            .optional()
            .describe(
              "Optional agent runtime override for the persona launch."
            ),
          includeDiff: z
            .boolean()
            .default(true)
            .describe(
              "Whether to include the git diff in the persona prompt. Set to false for non-code reviews (PRDs, docs, media) where the diff is not the review target."
            ),
        },
      },
      async (args) => {
        try {
          const result = await launchPersona(agentId, {
            persona: args.persona,
            context: args.context,
            agentType: args.agentType,
            includeDiff: args.includeDiff,
          });
          const text = buildLaunchPersonaResponseText(
            result.persona,
            result.agentId
          );
          return {
            content: [{ type: "text", text }],
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  // ── dispatch_get_feedback ───────────────────────────────────────────
  if (allowed.has("dispatch_get_feedback") && callbacks.getFeedback) {
    const getFeedback = callbacks.getFeedback;

    server.registerTool(
      "dispatch_get_feedback",
      {
        description:
          "Retrieve structured feedback submitted by persona agents you launched. Returns feedback grouped by persona. Only returns feedback from your direct child persona agents.",
        inputSchema: {
          persona: z
            .string()
            .optional()
            .describe(
              "Filter to a specific persona by name. If omitted, returns feedback from all child personas."
            ),
          limit: z
            .number()
            .int()
            .positive()
            .max(100)
            .default(100)
            .describe(
              "Maximum number of feedback items to return. Defaults and caps at 100."
            ),
        },
      },
      async (args) => {
        try {
          const result = await getFeedback(agentId, {
            persona: args.persona,
            limit: args.limit,
          });
          const totalItems = result.personas.reduce(
            (sum, p) => sum + p.feedback.length,
            0
          );
          const summary =
            result.personas.length === 0
              ? "No persona feedback found."
              : `Found ${totalItems} feedback item(s) from ${result.personas.length} persona(s).`;
          return {
            content: [{ type: "text", text: summary }],
            structuredContent: result,
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  // ── dispatch_resolve_feedback ───────────────────────────────────────
  if (allowed.has("dispatch_resolve_feedback") && callbacks.resolveFeedback) {
    const resolveFeedback = callbacks.resolveFeedback;

    server.registerTool(
      "dispatch_resolve_feedback",
      {
        description:
          "Mark a feedback item as fixed or ignored. If status is 'ignored', you must include a `reason` explaining why — the reviewer sees the reason in their recheck pass. If status is 'fixed', `reason` is optional but encouraged when the fix is non-obvious. The server records the current HEAD commit at the time of the call as the resolution commit.",
        inputSchema: {
          feedbackId: z
            .number()
            .int()
            .positive()
            .describe("The ID of the feedback item to resolve."),
          status: z
            .enum(["fixed", "ignored"])
            .describe(
              "Resolution status: 'fixed' if addressed, 'ignored' if not applicable."
            ),
          reason: z
            .string()
            .max(10_000)
            .optional()
            .describe(
              "Why you chose this resolution. REQUIRED when status is 'ignored'. Optional but encouraged for 'fixed'. Max 10,000 characters."
            ),
        },
      },
      async (args) => {
        try {
          const result = await resolveFeedback(
            agentId,
            args.feedbackId,
            args.status,
            { reason: args.reason ?? null }
          );
          return {
            content: [
              {
                type: "text",
                text: `Feedback #${result.id} marked as ${result.status}.`,
              },
            ],
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  // ── dispatch_review_list_feedback ────────────────────────────────
  if (
    allowed.has("dispatch_review_list_feedback") &&
    callbacks.listReviewFeedback
  ) {
    const listReviewFeedback = callbacks.listReviewFeedback;

    server.registerTool(
      "dispatch_review_list_feedback",
      {
        description:
          "List review feedback items for reviews this agent participates in. Returns item IDs, file locations, status, resolution, and the complete tracked thread. Optionally filter by reviewId.",
        inputSchema: {
          reviewId: z.number().int().positive().optional(),
        },
      },
      async (args) => {
        try {
          const items = await listReviewFeedback(agentId, args.reviewId);
          const summary =
            items.length === 0
              ? "No review feedback items found."
              : `Found ${items.length} review feedback item(s).`;
          return {
            content: [{ type: "text", text: summary }],
            structuredContent: { items },
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  if (allowed.has("dispatch_review_reopen") && callbacks.reopenReviewFeedback) {
    const reopenReviewFeedback = callbacks.reopenReviewFeedback;
    server.registerTool(
      "dispatch_review_reopen",
      {
        description:
          "Reopen a resolved review feedback item when the parent agent determines more work or discussion is needed. The review status is recomputed automatically.",
        inputSchema: {
          itemId: z.number().int().positive(),
          note: z.string().max(10_000).optional(),
        },
      },
      async (args) => {
        try {
          const result = await reopenReviewFeedback(agentId, args.itemId, {
            note: args.note ?? null,
          });
          return {
            content: [
              {
                type: "text",
                text: `Review feedback #${args.itemId} reopened. Review status: ${result.reviewStatus}.`,
              },
            ],
            structuredContent: result,
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  // ── dispatch_review_resolve ──────────────────────────────────────
  if (
    allowed.has("dispatch_review_resolve") &&
    callbacks.resolveReviewFeedback
  ) {
    const resolveReviewFeedback = callbacks.resolveReviewFeedback;

    server.registerTool(
      "dispatch_review_resolve",
      {
        description:
          "Parent-only. Resolve a review feedback item as fixed or dismissed. Review status is automatically derived from the current feedback item states.",
        inputSchema: {
          itemId: z
            .number()
            .int()
            .positive()
            .describe("The ID of the review feedback item to resolve."),
          resolution: z
            .enum(["fixed", "dismissed"])
            .describe(
              "Resolution type: 'fixed' if addressed, 'dismissed' if closing without a change."
            ),
          note: z
            .string()
            .max(10_000)
            .optional()
            .describe(
              "Optional note explaining the resolution. Encouraged when dismissed."
            ),
        },
      },
      async (args) => {
        try {
          const result = await resolveReviewFeedback(
            agentId,
            args.itemId,
            args.resolution,
            { note: args.note ?? null }
          );
          return {
            content: [
              {
                type: "text",
                text: `Review feedback #${result.item.id} marked as ${args.resolution}. Review status: ${result.reviewStatus}.`,
              },
            ],
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  // ── dispatch_review_add_message ──────────────────────────────────
  if (
    allowed.has("dispatch_review_add_message") &&
    callbacks.addReviewThreadMessage
  ) {
    const addReviewThreadMessage = callbacks.addReviewThreadMessage;

    server.registerTool(
      "dispatch_review_add_message",
      {
        description: `Add a concise message to a review feedback item's thread. Use it only for a necessary clarifying question or essential explanation before resolving. ${AGENT_REVIEW_REPLY_GUIDANCE}`,
        inputSchema: {
          itemId: z
            .number()
            .int()
            .positive()
            .describe(
              "The ID of the review feedback item to add a message to."
            ),
          body: z
            .string()
            .min(1)
            .max(AGENT_REVIEW_REPLY_MAX_CHARS)
            .describe(
              "A brief plain-text or Markdown reply (1–2 short sentences)."
            ),
        },
      },
      async (args) => {
        try {
          const result = await addReviewThreadMessage(
            agentId,
            args.itemId,
            args.body
          );
          return {
            content: [
              {
                type: "text",
                text: `Message added to review feedback #${args.itemId} (message #${result.message.id}).`,
              },
            ],
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  // ── dispatch_submit_resolution ────────────────────────────────────
  if (allowed.has("dispatch_submit_resolution") && callbacks.submitResolution) {
    const submitResolution = callbacks.submitResolution;

    server.registerTool(
      "dispatch_submit_resolution",
      {
        description:
          "Call this after you have resolved every feedback item from a review and are ready for the reviewer to verify your work. `summary` is required — 1–3 sentences explaining what you addressed and what you chose to leave alone. IMPORTANT: commit your fixes before calling this. The server captures the current HEAD as the resolution commit, and the reviewer's round-2 diff is computed from that commit — if you submit with uncommitted changes, the reviewer sees an empty diff and will re-flag the same issues. Submitting the resolution triggers the reviewer's recheck pass. Rejected if any feedback item is still 'open' or if any 'ignored' item is missing a reason.",
        inputSchema: {
          personaAgentId: z
            .string()
            .describe(
              "The persona agent ID whose review you are resolving (the agent you launched via dispatch_launch_persona)."
            ),
          summary: z
            .string()
            .min(1)
            .max(10_000)
            .describe(
              "1–3 sentence narrative summary of what you addressed and what you left alone."
            ),
        },
      },
      async (args) => {
        try {
          const result = await submitResolution(agentId, {
            personaAgentId: args.personaAgentId,
            summary: args.summary,
          });
          return {
            content: [
              {
                type: "text",
                text: `Resolution submitted for review #${result.review.id} (round ${result.resolution.roundNumber}).`,
              },
            ],
            structuredContent: result,
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }
}

export function buildLaunchPersonaResponseText(
  persona: string,
  agentId: string
): string {
  return `Launched persona "${persona}" as review agent ${agentId}.

The reviewer will inspect the target and create a review only when it calls dispatch_review_submit. Dispatch will inject a structured REVIEW SUBMITTED block here with the review summary and any feedback item IDs.

If the review has feedback, call dispatch_review_list_feedback with its reviewId before acting. Keep all questions and explanations tracked in the corresponding item thread with dispatch_review_add_message. Resolve an item with dispatch_review_resolve when it is fixed or intentionally dismissed, and use dispatch_review_reopen if it needs more work.

A clean approval is also recorded: the reviewer submits a required summary with an empty feedback array, creating a resolved review with no items. No legacy round or recheck lifecycle is required.`;
}
