import type { FastifyReply } from "fastify";
import type { CheckoutView } from "@dispatch/runner-protocol";
import { imageMimeType } from "../../shared/git/diff-image.js";
import {
  WorkspaceError,
  workspaceViewError,
} from "../../files/workspace-view.js";
import { AgentError } from "../../agents/errors.js";
import type { AgentManager, AgentRecord } from "../../agents/manager.js";
export async function serveCheckoutView(
  agent: AgentRecord,
  view: CheckoutView,
  manager: Pick<AgentManager, "viewCheckout">,
  reply: FastifyReply,
  failure?: { message: string; logMessage: string }
) {
  try {
    const value = await manager.viewCheckout(agent, view);
    if (view.kind === "image") {
      const mime = imageMimeType(view.path);
      if (!mime || typeof value !== "string")
        throw new AgentError("Image not available.", 404);
      return reply
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "private, max-age=30")
        .type(mime)
        .send(Buffer.from(value, "base64"));
    }
    if (view.kind === "fileDiff" && !value)
      throw new AgentError("File not found in diff.", 404);
    return view.kind === "stats" ? { diffStats: value } : value;
  } catch (error) {
    if (error instanceof AgentError && error.statusCode !== 500)
      return reply.code(error.statusCode).send({ error: error.message });
    if (error instanceof WorkspaceError && error.status !== 500)
      return reply.code(error.status).send({ error: error.message });
    if (!failure) {
      const mapped = workspaceViewError(error);
      return reply.code(mapped.status).send({ error: mapped.message });
    }
    reply.log.warn({ err: error, agentId: agent.id }, failure.logMessage);
    return reply.code(500).send({ error: failure.message });
  }
}
