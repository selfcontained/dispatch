import { PLUGIN_AGENT_TYPES } from "../shared/agent-types.js";
import {
  ENGINE_INSTALL_COMMANDS,
  isEngineCapabilityOperation,
  isEngineOperation,
} from "@dispatch/runner-protocol/engine-management";
import type { FastifyInstance, FastifyRequest } from "fastify";
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
  z.object({
    type: z.literal("login_status"),
    loginId: z.string().min(1).max(128),
  }),
]);

const operationBodySchema = z.object({
  scope: scopeSchema,
  operation: engineOperationSchema,
});

// Browser cards look up the current login by engine, on any placement. The
// manager resolves its ID before sending login_status to the runner.
const currentLoginSchema = z.object({
  scope: scopeSchema,
  operation: z.object({
    type: z.literal("login_status"),
    engine: z.enum(["claude", "codex"]),
    loginId: z.undefined(),
  }),
});

/**
 * Engine install/update/sign-in for a placement: this machine's runner or a
 * named enrolled one. The one engine route set; main's `/system/engines`
 * sign-in routes are its aliases for the local placement. Ordinary `/api`
 * routes — the global auth hook protects them like every other control
 * route. Backed by `EngineManager`, which sends each placement's inventory
 * and sign-in to its runner.
 */
export async function registerEngineManagementRoutes(
  app: FastifyInstance,
  manager: EngineManager,
  options: {
    enabledAgentTypes?: () => Promise<readonly string[]>;
    canManageEngineUpdates?: (request: FastifyRequest) => Promise<boolean>;
  } = {}
): Promise<void> {
  app.get("/api/v1/engine-management/status", async (request, reply) => {
    const scope = parseScopeQuery(request.query);
    if (!scope)
      return reply.code(400).send({ error: "Invalid or missing scope." });
    return {
      engines: await manager.presentation(scope),
      canManage: (await options.canManageEngineUpdates?.(request)) ?? false,
    };
  });
  app.get("/api/v1/engine-management/auth", async (request, reply) => {
    const scope = parseScopeQuery(request.query);
    if (!scope)
      return reply.code(400).send({ error: "Invalid or missing scope." });
    return { engines: await manager.signInStatus(scope) };
  });
  app.get("/api/v1/engine-management/plugins", async (request, reply) => {
    const scope = parseScopeQuery(request.query);
    if (!scope)
      return reply.code(400).send({ error: "Invalid or missing scope." });
    const enabled = (await options.enabledAgentTypes?.()) ?? PLUGIN_AGENT_TYPES;
    const query = request.query as { refresh?: string };
    return {
      statuses: await manager.plugins(
        scope,
        PLUGIN_AGENT_TYPES.filter((engine) => enabled.includes(engine)),
        query.refresh === "true" || query.refresh === "1"
      ),
    };
  });

  app.get("/api/v1/engine-management/inventory", async (request, reply) => {
    const scope = parseScopeQuery(request.query);
    if (!scope) {
      return reply.code(400).send({ error: "Invalid or missing scope." });
    }
    const entries = await manager.inventory(scope);
    return {
      entries:
        entries?.map((entry) => ({
          ...entry,
          install: ENGINE_INSTALL_COMMANDS[entry.id],
        })) ?? null,
    };
  });

  app.get("/api/v1/engine-management/operations", async (request, reply) => {
    const scope = parseScopeQuery(request.query);
    if (!scope)
      return reply.code(400).send({ error: "Invalid scope or operation." });
    return { operations: await manager.operations(scope) };
  });

  app.post("/api/v1/engine-management/operations", async (request, reply) => {
    const current = currentLoginSchema.safeParse(request.body);
    if (current.success) {
      return {
        ack: await manager.currentLogin(
          current.data.scope,
          current.data.operation.engine
        ),
      };
    }
    const candidate = (request.body ?? {}) as Record<string, unknown>;
    const operation = candidate.operation;
    if (
      isEngineOperation(operation) &&
      isEngineCapabilityOperation(operation)
    ) {
      const scope = scopeSchema.safeParse(candidate.scope);
      if (!scope.success) {
        return reply.code(400).send({ error: "Invalid scope or operation." });
      }
      if (
        (operation.type === "plugin_status" ||
          operation.type === "plugin_install" ||
          operation.type === "plugin_update") &&
        !(
          await (options.enabledAgentTypes?.() ??
            Promise.resolve(PLUGIN_AGENT_TYPES))
        ).includes(operation.engine)
      )
        return reply
          .code(400)
          .send({ error: `${operation.engine} is not an enabled agent type.` });
      return { ack: await manager.rpc(scope.data, operation) };
    }
    const body = operationBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "Invalid scope or operation." });
    }
    const ack = await manager.rpc(body.data.scope, body.data.operation);
    return { ack };
  });
}
