import type { FastifyInstance, FastifyReply } from "fastify";

import type { AgentManager } from "../agents/manager.js";
import { resolveHeadSha } from "../shared/git/worktree.js";

type FeedbackRouteDeps = {
  agentManager: AgentManager;
  publishUiEvent: (event: unknown) => void;
  handleAgentError: (reply: FastifyReply, error: unknown) => FastifyReply;
};

export async function registerFeedbackRoutes(
  app: FastifyInstance,
  deps: FeedbackRouteDeps
): Promise<void> {
  app.get("/api/v1/agents/:id/feedback", async (request, reply) => {
    const params = request.params as { id?: string };
    const query = request.query as { scope?: unknown };
    const id = params.id ?? "";
    try {
      if (query.scope === "children") {
        const feedback = await deps.agentManager.listFeedbackByParent(id);
        return { feedback };
      }
      const agent = await deps.agentManager.getAgent(id);
      if (!agent) return reply.code(404).send({ error: "Agent not found." });
      const feedback = await deps.agentManager.listFeedback(id);
      return { feedback };
    } catch (error) {
      return deps.handleAgentError(reply, error);
    }
  });

  app.patch(
    "/api/v1/agents/:id/feedback/:feedbackId",
    async (request, reply) => {
      const params = request.params as { id?: string; feedbackId?: string };
      const body = request.body as {
        status?: unknown;
        reason?: unknown;
      } | null;
      const feedbackId = parseInt(params.feedbackId ?? "", 10);

      if (isNaN(feedbackId)) {
        return reply.code(400).send({ error: "Invalid feedback id." });
      }

      const validStatuses = [
        "open",
        "dismissed",
        "forwarded",
        "fixed",
        "ignored",
      ] as const;
      if (
        typeof body?.status !== "string" ||
        !(validStatuses as readonly string[]).includes(body.status)
      ) {
        return reply.code(400).send({
          error:
            "status must be one of: open, dismissed, forwarded, fixed, ignored",
        });
      }

      let reason: string | null = null;
      if (typeof body.reason === "string") {
        if (body.reason.length > 10_000) {
          return reply
            .code(400)
            .send({ error: "reason exceeds 10,000 character limit." });
        }
        reason = body.reason;
      } else if (body.reason !== undefined && body.reason !== null) {
        return reply
          .code(400)
          .send({ error: "reason must be a string if provided." });
      }

      if (body.status === "ignored" && !(reason && reason.trim().length > 0)) {
        return reply.code(400).send({
          error: "A reason is required when marking feedback as ignored.",
        });
      }

      try {
        const agentId = params.id ?? "";
        const isResolving =
          body.status === "fixed" || body.status === "ignored";
        const agent = isResolving
          ? await deps.agentManager.getAgent(agentId)
          : null;
        const resolutionCommit =
          isResolving && agent ? await resolveHeadSha(agent.cwd) : null;
        const updated = await deps.agentManager.updateFeedbackStatus(
          feedbackId,
          agentId,
          body.status as
            | "open"
            | "dismissed"
            | "forwarded"
            | "fixed"
            | "ignored",
          { reason, resolutionCommit }
        );
        if (!updated) {
          return reply.code(404).send({ error: "Feedback not found." });
        }
        deps.publishUiEvent({
          type: "feedback.updated",
          agentId,
          feedback: updated,
        });
        return { feedback: updated };
      } catch (error) {
        return deps.handleAgentError(reply, error);
      }
    }
  );
}
