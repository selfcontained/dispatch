import type { FastifyInstance } from "fastify";
import { remotePlacement, type WorkspaceView } from "@dispatch/runner-protocol";
import { agentWorkspaceDir } from "../../agents/workspace-target.js";
import { serveCheckoutView } from "./checkout-response.js";
import type { AgentRouteDeps } from "./shared.js";

export async function registerAgentWorkspaceRoutes(
  app: FastifyInstance,
  deps: Pick<AgentRouteDeps, "agentManager" | "observeCheckout">
): Promise<void> {
  app.get("/api/v1/agents/:id/workspace", async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as {
      path?: unknown;
      workspace?: unknown;
      file?: unknown;
      index?: unknown;
      generation?: unknown;
    };
    if (
      (query.path !== undefined && typeof query.path !== "string") ||
      typeof query.workspace !== "string"
    ) {
      return reply
        .code(400)
        .send({ error: "A workspace and relative path are required." });
    }
    const agent = await deps.agentManager.getAgent(id);
    if (!agent) return reply.code(404).send({ error: "Agent not found." });
    const placement = remotePlacement(agent.cwd);
    const workspace = placement ? agent.cwd : agentWorkspaceDir(agent);
    if (!workspace)
      return reply.code(404).send({ error: "This agent has no workspace." });
    // Older clients identify a runner checkout by its binding. Clients that
    // use the confirmed effective path still read through the same binding.
    if (
      query.workspace !== workspace &&
      !(placement && query.workspace === agent.workspacePath)
    )
      return reply
        .code(409)
        .send({ error: "Workspace changed. Reopen Files to continue." });
    deps.observeCheckout?.(agent);
    reply.header("Cache-Control", "no-store");
    const path = typeof query.path === "string" ? query.path : "";
    const view: WorkspaceView =
      query.index === "true"
        ? {
            kind: "index",
            generation:
              typeof query.generation === "string"
                ? query.generation.slice(0, 64)
                : "initial",
          }
        : { kind: query.file === "true" ? "preview" : "directory", path };
    return serveCheckoutView(agent, view, deps.agentManager, reply);
  });
}
