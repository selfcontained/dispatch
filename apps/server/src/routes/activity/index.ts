import type { FastifyInstance } from "fastify";

import type { ActivityRouteDeps } from "./shared.js";
import { registerActivityHistoryRoutes } from "./history-routes.js";
import { registerActivityTokenRoutes } from "./token-routes.js";

export type { ActivityRouteDeps } from "./shared.js";

export async function registerActivityRoutes(
  app: FastifyInstance,
  deps: ActivityRouteDeps
): Promise<void> {
  await registerActivityTokenRoutes(app, deps);
  await registerActivityHistoryRoutes(app, deps);
}
