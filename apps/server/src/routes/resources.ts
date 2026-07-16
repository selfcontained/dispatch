import type { FastifyInstance } from "fastify";

import type { ServiceResources } from "../observability/service-resources.js";

export async function registerResourceRoutes(
  app: FastifyInstance,
  resources: ServiceResources
): Promise<void> {
  app.get("/api/v1/system/resources", async (request, reply) => {
    const query = request.query as { window?: unknown };
    const windows: Record<string, number> = {
      "15m": 15 * 60 * 1000,
      "1h": 60 * 60 * 1000,
    };
    const requested = typeof query.window === "string" ? query.window : "1h";
    const windowMs = windows[requested];
    if (!windowMs) {
      return reply.code(400).send({ error: 'window must be "15m" or "1h".' });
    }
    return resources.getSnapshot(windowMs);
  });
}
