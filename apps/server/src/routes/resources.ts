import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import type { ServiceResources } from "../observability/service-resources.js";
import { writeServiceResourcesCollectionEnabled } from "../observability/service-resources-settings.js";

export async function registerResourceRoutes(
  app: FastifyInstance,
  deps: { pool: Pool; resources: ServiceResources }
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
    return deps.resources.getSnapshot(windowMs);
  });

  app.post("/api/v1/system/resources/settings", async (request, reply) => {
    const body = request.body as { enabled?: unknown } | null;
    if (typeof body?.enabled !== "boolean") {
      return reply.code(400).send({ error: "enabled must be a boolean." });
    }

    await writeServiceResourcesCollectionEnabled(deps.pool, body.enabled);
    deps.resources.setCollectionEnabled(body.enabled);
    return { collectionEnabled: deps.resources.isCollectionEnabled() };
  });
}
