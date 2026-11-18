import type { FastifyInstance } from "fastify";
import * as z from "zod/v4";

import {
  EngineManager,
  type EngineScope,
} from "../agents/remote/engine-manager.js";

const scopeSchema = z.union([
  z.object({ kind: z.literal("local") }),
  z.object({
    kind: z.literal("runner"),
    runnerId: z.string().min(1).max(128),
  }),
]);

function parseScopeQuery(query: unknown): EngineScope | null {
  const q = (query ?? {}) as Record<string, unknown>;
  const parsed = scopeSchema.safeParse({
    kind: q.scope,
    ...(q.scope === "runner" ? { runnerId: q.runnerId } : {}),
  });
  return parsed.success ? parsed.data : null;
}

const engineOperationSchema = z.union([
  z.object({ type: z.literal("status") }),
  z.object({
    type: z.literal("install"),
    engine: z.enum(["claude", "codex", "opencode"]),
  }),
  z.object({
    type: z.literal("update"),
    engine: z.enum(["claude", "codex", "opencode"]),
  }),
  z.object({
    type: z.literal("login_start"),
    engine: z.enum(["claude", "codex", "opencode"]),
    restart: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("login_submit"),
    loginId: z.string().min(1).max(128),
    code: z.string().min(1).max(2000),
  }),
  z.object({
    type: z.literal("login_cancel"),
    loginId: z.string().min(1).max(128),
  }),
]);

const operationBodySchema = z.object({
  scope: scopeSchema,
  operation: engineOperationSchema,
});

/**
 * Engine install/update/sign-in, scoped to this machine or a named runner.
 * Ordinary `/api` routes — the global auth hook protects them like every
 * other control route. Backed by `EngineManager`, which wraps the existing
 * local `EngineLogins`/`EngineUpdateOperations` untouched and forwards
 * runner-scoped operations over the wire.
 */
export async function registerEngineManagementRoutes(
  app: FastifyInstance,
  manager: EngineManager
): Promise<void> {
  app.get("/api/v1/engine-management/inventory", async (request, reply) => {
    const scope = parseScopeQuery(request.query);
    if (!scope) {
      return reply.code(400).send({ error: "Invalid or missing scope." });
    }
    return { entries: await manager.inventory(scope) };
  });

  app.post("/api/v1/engine-management/operations", async (request, reply) => {
    const body = operationBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "Invalid scope or operation." });
    }
    const ack = await manager.rpc(body.data.scope, body.data.operation);
    return { ack };
  });
}
