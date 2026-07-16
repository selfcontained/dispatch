import { randomUUID } from "node:crypto";

import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";

import type { AgentManager, AgentRecord } from "../agents/manager.js";
import {
  CLI_AGENT_TYPES,
  getEnabledAgentTypes,
  isCliAgentType,
} from "../agent-type-settings.js";
import {
  loadPersonaBySlug,
  loadPersonas,
  assemblePersonaPrompt,
} from "../personas/loader.js";
import { buildPersonaReviewDiff } from "../personas/review-diff.js";
import {
  buildPersonaKickoffPrompt,
  buildReviewSubmittedPrompt,
  buildReviewFeedbackAddedPrompt,
  buildReviewItemStatePrompt,
  buildReviewThreadUpdatePrompt,
} from "../reviews/injection-prompts.js";
import {
  refreshRemoteBaseRef,
  resolveBaseRef,
} from "../shared/git/base-ref.js";
import {
  resolveRepoRoot,
  resolveWorktreeRoot,
} from "../shared/git/git-context.js";
import { getPrStatus } from "../shared/github/pr.js";
import { runCommand } from "../shared/lib/run-command.js";
import {
  createReview,
  addReviewFeedbackItem,
  getReviewByReviewerAgent,
  getReviewRecord,
  resolveReviewFeedbackItem,
  reopenReviewFeedbackItem,
  addThreadMessage,
  listFeedbackItemsForAgent,
} from "../agents/reviews.js";
import type { ParentContextResult } from "../shared/mcp/server.js";
import type { PublishUiEvent, SendAgentPrompt } from "./mcp-handler-types.js";

const CODEX_FULL_ACCESS_ARG = "--dangerously-bypass-approvals-and-sandbox";
const CLAUDE_FULL_ACCESS_ARG = "--dangerously-skip-permissions";
const UNIQUE_AGENT_REVIEW_INDEX = "idx_reviews_unique_agent_reviewer";
const REVIEW_ALREADY_SUBMITTED_MESSAGE =
  "This reviewer has already submitted its review. Use dispatch_review_add_feedback for a new concern or dispatch_review_add_message for an existing thread.";

function isDuplicateAgentReviewError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const pgError = error as { code?: unknown; constraint?: unknown };
  return (
    pgError.code === "23505" && pgError.constraint === UNIQUE_AGENT_REVIEW_INDEX
  );
}

function validateReviewFeedbackLocation(input: {
  filePath?: string;
  startLine?: number;
  endLine?: number;
}): void {
  if (input.filePath) {
    const pathSegments = input.filePath.replaceAll("\\", "/").split("/");
    if (
      input.filePath.startsWith("/") ||
      /^[A-Za-z]:[\\/]/.test(input.filePath) ||
      pathSegments.includes("..")
    ) {
      throw new Error("Review feedback file paths must be repo-relative.");
    }
  }
  if (!input.filePath && (input.startLine || input.endLine)) {
    throw new Error("Review feedback line numbers require a filePath.");
  }
  if (input.endLine && !input.startLine) {
    throw new Error("Review feedback endLine requires startLine.");
  }
  if (input.endLine && input.startLine && input.endLine < input.startLine) {
    throw new Error(
      "Review feedback endLine must be greater than or equal to startLine."
    );
  }
}

type CreateReviewHandlersDeps = {
  pool: Pool;
  agentManager: AgentManager;
  publishUiEvent: PublishUiEvent;
  withStreamFlag: <T extends AgentRecord>(
    agent: T
  ) => T & { hasStream: boolean };
  sendAgentPrompt: SendAgentPrompt;
  appLog: Pick<FastifyBaseLogger, "warn">;
};

export function createReviewHandlers(deps: CreateReviewHandlersDeps) {
  const {
    pool,
    agentManager,
    publishUiEvent,
    withStreamFlag,
    sendAgentPrompt,
    appLog,
  } = deps;

  const sendPromptBestEffort = async (
    agentId: string | null,
    prompt: string
  ) => {
    if (!agentId) return;
    try {
      await sendAgentPrompt(agentId, prompt);
    } catch (error) {
      appLog.warn(
        { err: error, agentId },
        "Review prompt injection failed after the review mutation was saved"
      );
    }
  };

  return {
    async getParentContext(
      parentAgentId: string
    ): Promise<ParentContextResult> {
      const parent = await agentManager.getAgent(parentAgentId);
      if (!parent) throw new Error("Parent agent not found.");

      const pins = (parent.pins ?? []).map((p) => ({
        label: p.label,
        value: p.value,
        type: p.type,
      }));
      const media = await agentManager.listMedia(parentAgentId);

      return {
        pins,
        media: media.map((m) => ({
          fileName: m.fileName,
          filePath: m.filePath,
          description: m.description,
          source: m.source,
          sizeBytes: m.sizeBytes,
          createdAt: m.createdAt,
        })),
      };
    },

    async submitReview(
      agentId: string,
      input: {
        summary?: string;
        feedback: Array<{
          filePath?: string;
          startLine?: number;
          endLine?: number;
          comment: string;
        }>;
      }
    ) {
      const reviewer = await agentManager.getAgent(agentId);
      if (reviewer?.role !== "review" || !reviewer.parentAgentId) {
        throw new Error(
          "dispatch_review_submit is only available to review agents."
        );
      }
      const summary = input.summary?.trim() || null;
      if (input.feedback.length === 0 && !summary) {
        throw new Error(
          "summary is required for a clean approval with no feedback items."
        );
      }
      if (await getReviewByReviewerAgent(pool, agentId)) {
        throw new Error(REVIEW_ALREADY_SUBMITTED_MESSAGE);
      }
      const parent = await agentManager.getAgent(reviewer.parentAgentId);
      if (!parent) throw new Error("Parent agent not found.");

      for (const item of input.feedback) {
        validateReviewFeedbackLocation(item);
      }

      let review;
      try {
        review = await createReview(pool, {
          agentId: parent.id,
          assignedAgentId: parent.id,
          reviewerType: "agent",
          reviewerAgentId: reviewer.id,
          summary,
          baseRef: parent.baseBranch,
          items: input.feedback,
        });
      } catch (error) {
        if (isDuplicateAgentReviewError(error)) {
          throw new Error(REVIEW_ALREADY_SUBMITTED_MESSAGE);
        }
        throw error;
      }

      publishUiEvent({
        type: "review.created",
        agentId: parent.id,
        reviewId: review.id,
        reviewerAgentId: reviewer.id,
      });
      const submittedReviewer = await agentManager.getAgent(reviewer.id);
      if (submittedReviewer) {
        publishUiEvent({
          type: "agent.upsert",
          agent: withStreamFlag(submittedReviewer),
        });
      }
      await sendPromptBestEffort(
        parent.id,
        buildReviewSubmittedPrompt({
          reviewId: review.id,
          reviewerName: reviewer.persona ?? reviewer.name,
          reviewerAgentId: reviewer.id,
          summary,
          items: review.items.map((item) => ({
            id: item.id,
            filePath: item.filePath,
            lineStart: item.lineStart,
            body: item.messages[0]?.content.body ?? "",
          })),
        })
      );
      return { review };
    },

    async addReviewFeedback(
      agentId: string,
      input: {
        reviewId: number;
        filePath?: string;
        startLine?: number;
        endLine?: number;
        comment: string;
      }
    ) {
      const reviewer = await agentManager.getAgent(agentId);
      if (reviewer?.role !== "review") {
        throw new Error("Only review agents can add review feedback.");
      }
      validateReviewFeedbackLocation(input);
      const result = await addReviewFeedbackItem(
        pool,
        input.reviewId,
        agentId,
        input
      );
      if (!result) {
        throw new Error(
          `Review #${input.reviewId} was not submitted by this reviewer.`
        );
      }
      const review = await getReviewRecord(pool, input.reviewId);
      publishUiEvent({
        type: "review_feedback.updated",
        agentId: review?.agentId ?? reviewer.parentAgentId ?? agentId,
        feedbackItemId: result.item.id,
      });
      publishUiEvent({
        type: "review.updated",
        agentId: review?.agentId ?? reviewer.parentAgentId ?? agentId,
        reviewId: input.reviewId,
        status: result.reviewStatus,
      });
      await sendPromptBestEffort(
        review?.assignedAgentId ?? review?.agentId ?? reviewer.parentAgentId,
        buildReviewFeedbackAddedPrompt({
          reviewId: input.reviewId,
          itemId: result.item.id,
          reviewerName: reviewer.persona ?? reviewer.name,
          body: input.comment,
        })
      );
      return result;
    },

    async listReviewFeedback(agentId: string, reviewId?: number) {
      return listFeedbackItemsForAgent(pool, agentId, reviewId);
    },

    async resolveReviewFeedback(
      agentId: string,
      itemId: number,
      resolution: "fixed" | "dismissed",
      opts: { note?: string | null } = {}
    ): Promise<{
      item: {
        id: number;
        reviewId: number;
        status: string;
        resolution: string;
      };
      reviewStatus: string;
    }> {
      const result = await resolveReviewFeedbackItem(
        pool,
        itemId,
        agentId,
        resolution,
        {
          note: opts.note ?? null,
          resolvedBy: agentId,
          authorType: "agent",
        }
      );
      if (!result) {
        throw new Error(
          `Review feedback item #${itemId} not found or not owned by this agent.`
        );
      }
      publishUiEvent({
        type: "review_feedback.updated",
        agentId,
        feedbackItemId: itemId,
      });
      publishUiEvent({
        type: "review.updated",
        agentId,
        reviewId: result.reviewId,
        status: result.reviewStatus,
      });
      const review = await getReviewRecord(pool, result.reviewId);
      await sendPromptBestEffort(
        review?.reviewerAgentId ?? null,
        buildReviewItemStatePrompt({
          reviewId: result.reviewId,
          itemId,
          action: "resolved",
          resolution,
          note: opts.note ?? null,
        })
      );
      return {
        item: {
          id: result.item.id,
          reviewId: result.reviewId,
          status: result.item.status,
          resolution: result.item.resolution!,
        },
        reviewStatus: result.reviewStatus,
      };
    },

    async reopenReviewFeedback(
      agentId: string,
      itemId: number,
      opts: { note?: string | null } = {}
    ) {
      const result = await reopenReviewFeedbackItem(pool, itemId, agentId, {
        note: opts.note ?? null,
        reopenedBy: agentId,
        authorType: "agent",
      });
      if (!result) {
        throw new Error(
          `Review feedback item #${itemId} not found or not owned by this agent.`
        );
      }
      const review = await getReviewRecord(pool, result.reviewId);
      const eventAgentId = review?.agentId ?? agentId;
      publishUiEvent({
        type: "review_feedback.updated",
        agentId: eventAgentId,
        feedbackItemId: itemId,
      });
      publishUiEvent({
        type: "review.updated",
        agentId: eventAgentId,
        reviewId: result.reviewId,
        status: result.reviewStatus,
      });
      await sendPromptBestEffort(
        review?.reviewerAgentId ?? null,
        buildReviewItemStatePrompt({
          reviewId: result.reviewId,
          itemId,
          action: "reopened",
          note: opts.note ?? null,
        })
      );
      return {
        item: {
          id: result.item.id,
          reviewId: result.reviewId,
          status: result.item.status,
          resolution: null,
        },
        reviewStatus: result.reviewStatus,
      };
    },

    async addReviewThreadMessage(
      agentId: string,
      itemId: number,
      body: string
    ): Promise<{
      message: {
        id: number;
        feedbackItemId: number;
        content: { body: string };
      };
      reviewId: number;
    }> {
      const result = await addThreadMessage(
        pool,
        itemId,
        agentId,
        "agent",
        body,
        agentId
      );
      if (!result) {
        throw new Error(
          `Review feedback item #${itemId} not found or not owned by this agent.`
        );
      }
      const review = await getReviewRecord(pool, result.reviewId);
      publishUiEvent({
        type: "review_feedback.updated",
        agentId: review?.agentId ?? agentId,
        feedbackItemId: itemId,
      });
      const actor = await agentManager.getAgent(agentId);
      const targetAgentId =
        review?.reviewerAgentId === agentId
          ? (review.assignedAgentId ?? review.agentId)
          : (review?.reviewerAgentId ?? null);
      await sendPromptBestEffort(
        targetAgentId,
        buildReviewThreadUpdatePrompt({
          reviewId: result.reviewId,
          itemId,
          from: actor?.persona ?? actor?.name ?? agentId,
          body,
        })
      );
      return {
        message: {
          id: result.message.id,
          feedbackItemId: result.message.feedbackItemId,
          content: result.message.content,
        },
        reviewId: result.reviewId,
      };
    },

    async listPersonas(
      agentCwd: string
    ): Promise<Array<{ slug: string; name: string; description: string }>> {
      const personas = await loadPersonas(agentCwd);
      return personas.map(({ slug, name, description }) => ({
        slug,
        name,
        description,
      }));
    },

    async launchPersona(
      agentId: string,
      opts: {
        persona: string;
        context: string;
        agentType?: (typeof CLI_AGENT_TYPES)[number];
        includeDiff?: boolean;
      }
    ): Promise<{ agentId: string; persona: string; parentAgentId: string }> {
      const parent = await agentManager.getAgent(agentId);
      if (!parent) throw new Error("Parent agent not found.");

      const fallbackReviewType = isCliAgentType(parent.reviewAgentType)
        ? parent.reviewAgentType
        : null;
      const fallbackParentType =
        parent.type === "claude" || parent.type === "opencode"
          ? parent.type
          : "codex";
      const personaAgentType: (typeof CLI_AGENT_TYPES)[number] =
        opts.agentType ?? fallbackReviewType ?? fallbackParentType;
      if (!CLI_AGENT_TYPES.includes(personaAgentType)) {
        throw new Error(
          `Unsupported persona agent type "${personaAgentType}".`
        );
      }

      const enabledAgentTypes = await getEnabledAgentTypes(pool);
      if (!enabledAgentTypes.includes(personaAgentType)) {
        throw new Error(`${personaAgentType} agents are disabled in settings.`);
      }

      const parentCwd = parent.worktreePath ?? parent.cwd;
      let personaRoot: string;
      try {
        personaRoot = await resolveWorktreeRoot(parentCwd);
      } catch {
        try {
          personaRoot = await resolveRepoRoot(parentCwd);
        } catch {
          throw new Error("Parent agent is not in a git repository.");
        }
      }

      let persona = await loadPersonaBySlug(personaRoot, opts.persona);
      if (!persona) {
        try {
          const repoRoot = await resolveRepoRoot(parentCwd);
          if (repoRoot !== personaRoot) {
            persona = await loadPersonaBySlug(repoRoot, opts.persona);
          }
        } catch {}
      }
      if (!persona) {
        throw new Error(
          `Persona "${opts.persona}" not found in .dispatch/personas/.`
        );
      }

      const includeDiff = opts.includeDiff !== false;
      let diffResult = null;
      if (includeDiff) {
        let reviewBaseBranch: string | null =
          parent.baseBranch ??
          (parent.worktreePath && parent.worktreeBranch ? "main" : null);

        if (reviewBaseBranch == null) {
          try {
            const pr = await getPrStatus({ cwd: parentCwd }, runCommand);
            if (pr.baseRefName) {
              reviewBaseBranch = pr.baseRefName;
            }
          } catch {
            // No PR or gh CLI unavailable — fall through to existing fallback.
          }
        }

        const allowUpstreamFallback = reviewBaseBranch == null;
        await refreshRemoteBaseRef(parentCwd, reviewBaseBranch, {
          runCommand,
          allowUpstreamFallback,
        });
        const baseRef =
          (await resolveBaseRef(parentCwd, reviewBaseBranch, {
            runCommand,
            allowUpstreamFallback,
          })) ?? "origin/main";
        diffResult = await buildPersonaReviewDiff(
          parentCwd,
          baseRef,
          runCommand
        );
      }
      const prompt = assemblePersonaPrompt(persona, opts.context, diffResult, {
        includeDiff,
        agentType: personaAgentType,
      });

      const personaArgs: string[] = ["--append-system-prompt", prompt];
      if (parent.fullAccess) {
        const fullAccessArg =
          personaAgentType === "claude"
            ? CLAUDE_FULL_ACCESS_ARG
            : personaAgentType === "codex"
              ? CODEX_FULL_ACCESS_ARG
              : null;
        if (fullAccessArg) {
          personaArgs.push(fullAccessArg);
        }
      }

      const cliSessionId =
        personaAgentType === "claude" ? randomUUID() : undefined;

      const agent = await agentManager.createAgent({
        name: `${opts.persona}-${agentId.slice(-6)}`,
        type: personaAgentType,
        role: "review",
        cwd: parentCwd,
        agentArgs: personaArgs,
        fullAccess: parent.fullAccess,
        useWorktree: false,
        persona: opts.persona,
        parentAgentId: agentId,
        personaContext: opts.context,
        cliSessionId,
        initialPrompt: buildPersonaKickoffPrompt(),
      });

      const agentWithReview = await agentManager.getAgent(agent.id);
      publishUiEvent({
        type: "agent.upsert",
        agent: withStreamFlag(agentWithReview ?? agent),
      });

      return {
        agentId: agent.id,
        persona: opts.persona,
        parentAgentId: agentId,
      };
    },
  };
}
