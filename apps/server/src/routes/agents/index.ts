import type { FastifyInstance } from "fastify";

import type { AgentRouteDeps } from "./shared.js";
import { registerAgentCrudRoutes } from "./crud-routes.js";
import { registerAgentEventRoutes } from "./events-routes.js";
import { registerAgentLifecycleRoutes } from "./lifecycle-routes.js";
import { registerAgentPromptRoutes } from "./prompt-routes.js";
import { registerAgentStreamingRoutes } from "./streaming-routes.js";
import { registerAgentUsageRoutes } from "./usage-routes.js";

export type { AgentRouteDeps } from "./shared.js";

export async function registerAgentRoutes(
  app: FastifyInstance,
  deps: AgentRouteDeps
): Promise<void> {
  await registerAgentEventRoutes(app, deps);
  await registerAgentCrudRoutes(app, deps);
  await registerAgentLifecycleRoutes(app, deps);
  await registerAgentStreamingRoutes(app, deps);
  await registerAgentPromptRoutes(app, deps);
  await registerAgentUsageRoutes(app, deps);
}
