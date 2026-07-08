import type { FastifyInstance } from "fastify";

import type { AgentRouteDeps } from "./shared.js";
import { registerAgentCrudRoutes } from "./crud-routes.js";
import { registerAgentEventRoutes } from "./events-routes.js";
import { registerAgentLifecycleRoutes } from "./lifecycle-routes.js";
import { registerAgentStreamingRoutes } from "./streaming-routes.js";
import { registerAgentReviewRoutes } from "./review-routes.js";
import { registerAgentTerminalRoutes } from "./terminal-routes.js";

export type { AgentRouteDeps } from "./shared.js";

export async function registerAgentRoutes(
  app: FastifyInstance,
  deps: AgentRouteDeps
): Promise<void> {
  await registerAgentEventRoutes(app, deps);
  await registerAgentCrudRoutes(app, deps);
  await registerAgentLifecycleRoutes(app, deps);
  await registerAgentReviewRoutes(app, deps);
  await registerAgentStreamingRoutes(app, deps);
  await registerAgentTerminalRoutes(app, deps);
}
