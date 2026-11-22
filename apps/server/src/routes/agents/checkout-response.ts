import type { FastifyReply } from "fastify";
import type { CheckoutView } from "@dispatch/runner-protocol";
import { imageMimeType } from "../../shared/git/diff-image.js";
import { WorkspaceError } from "../../files/workspace-view.js";
import { AgentError } from "../../agents/errors.js";
import type { AgentManager, AgentRecord } from "../../agents/manager.js";
export async function serveCheckoutView(
  agent: AgentRecord,
  view: CheckoutView,
  manager: Pick<AgentManager, "viewCheckout">,
  reply: FastifyReply
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
    const status =
      error instanceof WorkspaceError
        ? error.status
        : error instanceof AgentError
          ? error.statusCode
          : 500;
    return reply.code(status).send({
      error:
        status === 500 ? "Unable to read checkout." : (error as Error).message,
    });
  }
}
