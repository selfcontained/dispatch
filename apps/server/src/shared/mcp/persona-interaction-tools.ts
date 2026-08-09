import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import {
  AGENT_REVIEW_REPLY_GUIDANCE,
  AGENT_REVIEW_REPLY_MAX_CHARS,
  AGENT_REVIEW_SUMMARY_MAX_CHARS,
} from "../review-limits.js";

import { mergePersonasWithWorktreePrecedence } from "../../personas/loader.js";
import {
  getPersonaTemplate,
  PERSONA_TEMPLATES,
  upsertPersona,
  validatePersonas,
} from "../../personas/authoring.js";
import { describeAgentModelCatalog } from "../agent-models.js";
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
  parentAgentId?: string | null;
  worktreeRoot?: string | null;
  repoRoot?: string | null;
  listPersonas?: McpRequestContext["listPersonas"];
  launchPersona?: McpRequestContext["launchPersona"];
  resolveReviewFeedback?: McpRequestContext["resolveReviewFeedback"];
  reopenReviewFeedback?: McpRequestContext["reopenReviewFeedback"];
  submitReview?: McpRequestContext["submitReview"];
  addReviewFeedback?: McpRequestContext["addReviewFeedback"];
  addReviewThreadMessage?: McpRequestContext["addReviewThreadMessage"];
  listReviewFeedback?: McpRequestContext["listReviewFeedback"];
  getParentContext?: McpRequestContext["getParentContext"];
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

  const personaRoot = callbacks.worktreeRoot ?? callbacks.repoRoot;

  if (allowed.has("persona_templates")) {
    server.registerTool(
      "persona_templates",
      {
        description:
          "Return concise examples and exact authoring fields for repository-specific review personas. Use these as a starting point, then create a tailored persona with persona_upsert.",
        inputSchema: {},
      },
      async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({ templates: PERSONA_TEMPLATES }, null, 2),
          },
        ],
        structuredContent: { templates: PERSONA_TEMPLATES },
      })
    );
  }

  if (allowed.has("persona_upsert") && personaRoot) {
    server.registerTool(
      "persona_upsert",
      {
        description:
          "Create or update a repository persona in .dispatch/personas/. Provide repo-specific instructions; optionally start from a short built-in template. This writes only in the current workspace.",
        inputSchema: {
          slug: z.string().min(1).max(80),
          template: z
            .string()
            .optional()
            .describe("Optional template ID returned by persona_templates."),
          name: z.string().max(200).optional(),
          description: z.string().max(500).optional(),
          instructions: z.string().max(20_000).optional(),
          feedbackFormat: z.string().max(100).optional(),
        },
      },
      async (args) => {
        try {
          const template = args.template
            ? getPersonaTemplate(args.template)
            : undefined;
          if (args.template && !template)
            throw new Error(
              `Unknown persona template: ${args.template}. Call persona_templates for available IDs.`
            );
          const name = args.name ?? template?.name;
          const description = args.description ?? template?.personaDescription;
          const instructions = args.instructions ?? template?.instructions;
          if (!name || !description || !instructions)
            throw new Error(
              "name, description, and instructions are required unless supplied by a template."
            );
          const result = await upsertPersona({
            root: personaRoot,
            slug: args.slug,
            name,
            description,
            instructions,
            feedbackFormat: args.feedbackFormat,
          });
          return {
            content: [
              {
                type: "text",
                text: `${result.created ? "Created" : "Updated"} ${result.path}.`,
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

  if (allowed.has("persona_validate") && personaRoot) {
    server.registerTool(
      "persona_validate",
      {
        description:
          "Validate persona files in the current workspace. Reports required metadata and instruction errors without modifying files.",
        inputSchema: {},
      },
      async () => {
        try {
          const personas = await validatePersonas(personaRoot);
          const valid = personas.every((persona) => persona.valid);
          return {
            content: [
              {
                type: "text",
                text:
                  personas.length === 0
                    ? "No persona files found."
                    : valid
                      ? `All ${personas.length} persona file(s) are valid.`
                      : `${personas.filter((persona) => !persona.valid).length} invalid persona file(s) found.`,
              },
            ],
            structuredContent: { valid, personas },
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

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
        description: `Submit this reviewer's completed initial pass. Creates one agent-authored review assigned to the parent agent. When feedback items capture the findings, omit \`summary\` unless there is one non-duplicative overall takeaway. A summary is limited to ${AGENT_REVIEW_SUMMARY_MAX_CHARS} characters; a nonblank summary is required for a clean approval with no feedback.`,
        inputSchema: {
          summary: z
            .string()
            .trim()
            .max(AGENT_REVIEW_SUMMARY_MAX_CHARS)
            .optional(),
          feedback: z.array(z.object(feedbackItemSchema)).max(100).default([]),
        },
      },
      async (args) => {
        try {
          const summary = args.summary?.trim() || undefined;
          if (args.feedback.length === 0 && !summary) {
            throw new Error(
              "summary is required for a clean approval with no feedback items."
            );
          }
          const result = await submitReview(agentId, { ...args, summary });
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
          "Retrieve the parent agent's pins and shared media. Use this to discover dev server URLs, key files, screenshots, and other context the parent agent has surfaced. Shared media includes an absolute filePath for direct inspection.",
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
            for (const media of result.media) {
              parts.push(
                `  ${media.fileName} (${media.sizeBytes} bytes) at ${media.filePath}: ${media.description ?? "(no description)"}`
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
          model: z
            .string()
            .optional()
            .describe(
              "Optional model id for the reviewer, matching its agent type. Omit to use the CLI default. " +
                describeAgentModelCatalog()
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
            model: args.model,
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
          "Resolve a review feedback item as fixed or dismissed. For persona reviews, the reviewer uses this only after re-inspecting the assignee's fix; the assignee should request verification with dispatch_review_add_message instead of resolving the item. Review status is automatically derived from the current feedback item states.",
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
        description: `Add a concise message to a review feedback item's thread. For persona feedback, the assignee uses this after fixing an item to request reviewer verification; the reviewer uses it to give further instructions when a fix is incomplete. ${AGENT_REVIEW_REPLY_GUIDANCE}`,
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
}

export function buildLaunchPersonaResponseText(
  persona: string,
  agentId: string
): string {
  return `Launched persona "${persona}" as review agent ${agentId}.

The reviewer will inspect the target and create a review only when it calls dispatch_review_submit. Dispatch will inject a structured REVIEW SUBMITTED block here with the review summary and any feedback item IDs.

Do not poll, sleep, call list_agents, or schedule a wakeup while waiting for the review. If you were asked to launch more reviewers, call this tool again for each one first. End this turn once every reviewer for this pass is launched; Dispatch will notify you with a new injected REVIEW SUBMITTED block as each reviewer submits.

If the review has feedback, call dispatch_review_list_feedback with its reviewId before acting. Keep all questions and explanations tracked in the corresponding item thread with dispatch_review_add_message. After fixing an item, post a concise message asking the reviewer to verify it; do not call dispatch_review_resolve on persona feedback yourself. The reviewer will re-inspect the fix and resolve it if complete, or leave it open and reply with further instructions.

A clean approval is also recorded: the reviewer submits a required summary with an empty feedback array, creating a resolved review with no items. No legacy round or recheck lifecycle is required.`;
}
