import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import type {
  AgentManager,
  AgentRecord,
  PersonaReviewRecord,
  PersonaReviewResolutionRecord,
} from "../agents/manager.js";
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
  buildParentRound1FeedbackPrompt,
  buildParentReviewCompletePrompt,
  buildPersonaKickoffPrompt,
  buildReviewerRecheckCancelledPrompt,
  buildReviewerRecheckReadyPrompt,
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
import { resolveHeadSha } from "../shared/git/worktree.js";
import { runCommand } from "../shared/lib/run-command.js";
import {
  resolveReviewFeedbackItem,
  addThreadMessage,
} from "../agents/reviews.js";
import type {
  ParentContextResult,
  RecheckContextResult,
} from "../shared/mcp/server.js";
import type { PublishUiEvent, SendAgentPrompt } from "./mcp-handler-types.js";

const CODEX_FULL_ACCESS_ARG = "--dangerously-bypass-approvals-and-sandbox";
const CLAUDE_FULL_ACCESS_ARG = "--dangerously-skip-permissions";

type CreateReviewHandlersDeps = {
  pool: Pool;
  agentManager: AgentManager;
  publishUiEvent: PublishUiEvent;
  withStreamFlag: <T extends AgentRecord>(
    agent: T
  ) => T & { hasStream: boolean };
  sendAgentPrompt: SendAgentPrompt;
};

export function createReviewHandlers(deps: CreateReviewHandlersDeps) {
  const {
    pool,
    agentManager,
    publishUiEvent,
    withStreamFlag,
    sendAgentPrompt,
  } = deps;

  return {
    async submitResolution(
      agentId: string,
      input: { personaAgentId: string; summary: string }
    ): Promise<{
      review: PersonaReviewRecord;
      resolution: PersonaReviewResolutionRecord;
    }> {
      const parent = await agentManager.getAgent(agentId);
      if (!parent) throw new Error("Agent not found.");
      const resolutionCommit = await resolveHeadSha(parent.cwd);
      const result = await agentManager.submitReviewResolution({
        parentAgentId: agentId,
        personaAgentId: input.personaAgentId,
        summary: input.summary,
        resolutionCommit,
      });
      const [child, parentAgent] = await Promise.all([
        agentManager.getAgent(input.personaAgentId),
        agentManager.getAgent(agentId),
      ]);
      if (child) {
        publishUiEvent({
          type: "agent.upsert",
          agent: withStreamFlag(child),
        });
      }
      if (parentAgent) {
        publishUiEvent({
          type: "agent.upsert",
          agent: withStreamFlag(parentAgent),
        });
      }

      if (result.review.status === "awaiting_recheck" && child) {
        await sendAgentPrompt(
          input.personaAgentId,
          buildReviewerRecheckReadyPrompt()
        );
      }

      return result;
    },

    async cancelRecheck(
      agentId: string,
      input: { personaAgentId: string; reason?: string }
    ): Promise<void> {
      const { review, transitioned } = await agentManager.cancelReviewRecheck({
        parentAgentId: agentId,
        personaAgentId: input.personaAgentId,
        reason: input.reason ?? null,
      });
      const [child, parent] = await Promise.all([
        agentManager.getAgent(input.personaAgentId),
        agentManager.getAgent(review.parentAgentId),
      ]);
      if (child) {
        publishUiEvent({
          type: "agent.upsert",
          agent: withStreamFlag(child),
        });
      }
      if (parent) {
        publishUiEvent({
          type: "agent.upsert",
          agent: withStreamFlag(parent),
        });
      }
      if (!transitioned) return;

      await sendAgentPrompt(
        input.personaAgentId,
        buildReviewerRecheckCancelledPrompt({
          reason: input.reason ?? null,
        })
      );
    },

    async updateReviewStatus(
      agentId: string,
      input: { status: string; message?: string }
    ): Promise<void> {
      const review = await agentManager.updatePersonaReviewStatus(
        agentId,
        input
      );
      const [child, parent] = await Promise.all([
        agentManager.getAgent(agentId),
        agentManager.getAgent(review.parentAgentId),
      ]);
      if (child) {
        publishUiEvent({
          type: "agent.upsert",
          agent: withStreamFlag(child),
        });
      }
      if (parent) {
        publishUiEvent({
          type: "agent.upsert",
          agent: withStreamFlag(parent),
        });
      }
    },

    async completeReview(
      agentId: string,
      input: {
        verdict: string;
        summary: string;
        filesReviewed?: string[];
        message?: string;
      }
    ): Promise<void> {
      const personaAgent = await agentManager.getAgent(agentId);
      const lastReviewedCommit = personaAgent
        ? await resolveHeadSha(personaAgent.cwd)
        : null;
      const review = await agentManager.completePersonaReview(agentId, {
        ...input,
        lastReviewedCommit,
      });
      const [child, parent] = await Promise.all([
        agentManager.getAgent(agentId),
        agentManager.getAgent(review.parentAgentId),
      ]);
      if (child) {
        publishUiEvent({
          type: "agent.upsert",
          agent: withStreamFlag(child),
        });
      }
      if (parent) {
        publishUiEvent({
          type: "agent.upsert",
          agent: withStreamFlag(parent),
        });
      }

      const feedbackCount = await agentManager.countFeedbackForAgent(agentId);
      const isMidRoundTrip = review.roundNumber < 2;
      const cleanApproval =
        isMidRoundTrip && input.verdict === "approve" && feedbackCount === 0;
      const parentPrompt =
        isMidRoundTrip && !cleanApproval
          ? buildParentRound1FeedbackPrompt({
              persona: review.persona,
              personaAgentId: agentId,
              verdict: input.verdict,
              feedbackCount,
            })
          : buildParentReviewCompletePrompt({
              persona: review.persona,
              personaAgentId: agentId,
              verdict: input.verdict,
              summary: input.summary,
              feedbackCount,
              roundNumber: review.roundNumber,
            });
      await sendAgentPrompt(review.parentAgentId, parentPrompt);
    },

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

    async getRecheckContext(
      agentId: string
    ): Promise<RecheckContextResult | null> {
      const review = await agentManager.getPersonaReview(agentId);
      if (!review) {
        return null;
      }

      const resolution = (
        await agentManager.getReviewResolutions(review.id)
      ).at(-1);
      const lastReviewedCommit = review.lastReviewedCommit;
      const resolutionCommit = resolution?.resolutionCommit ?? null;
      const resolutions = resolution
        ? await agentManager.listResolvedFeedbackForRound(
            agentId,
            resolution.roundNumber
          )
        : [];
      const availability =
        review.status === "cancelled"
          ? "cancelled"
          : review.status === "awaiting_recheck"
            ? "ready"
            : review.status === "complete" && review.roundNumber >= 2
              ? "complete"
              : "waiting_for_resolution";
      const looksLikeSha = (value: string): boolean =>
        /^[0-9a-f]{4,64}$/i.test(value);
      const compareRange =
        availability === "ready" &&
        lastReviewedCommit &&
        resolutionCommit &&
        looksLikeSha(lastReviewedCommit) &&
        looksLikeSha(resolutionCommit)
          ? `${lastReviewedCommit}...${resolutionCommit}`
          : null;

      return {
        availability,
        reviewStatus: review.status,
        persona: review.persona,
        reviewId: review.id,
        reviewRoundNumber: review.roundNumber,
        resolutionRoundNumber: resolution?.roundNumber ?? null,
        resolutionSummary: resolution?.summary ?? null,
        lastReviewedCommit,
        resolutionCommit,
        compareRange,
        gitDiffCommand: compareRange ? `git diff ${compareRange}` : null,
        submittedAt: resolution?.submittedAt ?? null,
        resolutions,
      };
    },

    async resolveReviewFeedback(
      agentId: string,
      itemId: number,
      resolution: "fixed" | "ignored" | "wont_fix",
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
        { note: opts.note ?? null, resolvedBy: agentId }
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
      publishUiEvent({
        type: "review_feedback.updated",
        agentId,
        feedbackItemId: itemId,
      });
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

      const launchCommit = await resolveHeadSha(parentCwd);
      await agentManager.createPersonaReview({
        agentId: agent.id,
        parentAgentId: agentId,
        persona: opts.persona,
        lastReviewedCommit: launchCommit,
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
