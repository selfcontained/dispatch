import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

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
          "Launch a persona agent to review or test your current work. The persona runs in your working directory with specialized instructions. Available personas are defined in .dispatch/personas/ as markdown files. Reviews always include a recheck pass — the reviewer stays alive after its initial verdict and performs a second pass after you call dispatch_submit_resolution.",
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
          "List human review feedback items for this agent. Returns all feedback items across all reviews, including their IDs, file paths, status, resolution, and thread messages. Use this to discover item IDs before calling dispatch_review_resolve or dispatch_review_add_message.",
        inputSchema: {},
      },
      async () => {
        try {
          const items = await listReviewFeedback(agentId);
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
          "Resolve a human review feedback item. Marks the item as fixed, dismissed, or wont_fix. The parent review status is automatically recomputed (open → partially_resolved → resolved).",
        inputSchema: {
          itemId: z
            .number()
            .int()
            .positive()
            .describe("The ID of the review feedback item to resolve."),
          resolution: z
            .enum(["fixed", "ignored", "wont_fix"])
            .describe(
              "Resolution type: 'fixed' if addressed, 'ignored' if not applicable, 'wont_fix' if acknowledged but intentionally left."
            ),
          note: z
            .string()
            .max(10_000)
            .optional()
            .describe(
              "Optional note explaining the resolution. Encouraged for 'dismissed' and 'wont_fix'."
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
        description:
          "Add a message to a review feedback item's thread. Use this to reply to a human review comment — for example, to ask a clarifying question or explain your approach before resolving.",
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
            .max(50_000)
            .describe("The message body (plain text or markdown)."),
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
  return `Launched persona "${persona}" as agent ${agentId}.

This is a multi-step round-trip review — do not emit a terminal dispatch_event yet. The reviewer will stay alive waiting for your resolution, and the server will push a new prompt into this terminal when each round transitions.

1. Wait for round 1. The server will inject a new prompt here when the reviewer submits their round-1 verdict. There is no tool to poll — keep this turn alive however your agent runtime allows, then act on the prompt when it arrives.

2. When the round-1 prompt arrives, call dispatch_get_feedback (personaAgentId="${agentId}") to read the items. For each one, decide if you'll fix it or ignore it. Apply the fix, then call dispatch_resolve_feedback (status 'fixed' or 'ignored' — include a 'reason' for any you ignore).

3. Commit your fixes before submitting the resolution. dispatch_submit_resolution captures the current HEAD as the resolution commit, and the reviewer's round-2 diff is computed from that commit. If you submit while your fixes are uncommitted, the reviewer sees an empty diff and will re-flag the same issues.

4. Call dispatch_submit_resolution with a 1–3 sentence summary of what you addressed. This triggers the reviewer's round-2 pass.

5. Wait for round 2. The server will inject another prompt here when the reviewer submits their round-2 verdict. Read any new findings (filter dispatch_get_feedback for items where respondsToFeedbackId points at one of your round-1 items), then wrap up and emit a terminal dispatch_event.`;
}
