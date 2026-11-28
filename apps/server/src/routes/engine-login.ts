import type { FastifyInstance } from "fastify";
import * as z from "zod/v4";

import {
  isLoginEngine,
  type EngineAuthStatus,
  type EngineLogin,
} from "@dispatch/shared";

import type {
  EngineManager,
  EngineScope,
} from "../agents/remote/engine-manager.js";

const startBodySchema = z.object({ restart: z.boolean().optional() });
const codeBodySchema = z.object({ code: z.string().min(1).max(2000) });

const local: EngineScope = { kind: "local" };

/** A sign-in ack as main's route answered it. */
function answer(
  reply: { code(status: number): { send(body: unknown): unknown } },
  ack: Awaited<ReturnType<EngineManager["login"]>>
) {
  if (!ack.ok || !ack.login)
    return reply.code(404).send({ error: "Sign-in not found." });
  return { login: ack.login as EngineLogin };
}

/**
 * main's engine sign-in routes: aliases of the engine-management routes for
 * the local placement, with main's paths, bodies, status codes and text.
 * The sign-in itself runs on the local runner (see EngineManager).
 */
export async function registerEngineLoginRoutes(
  app: FastifyInstance,
  manager: EngineManager
): Promise<void> {
  app.addHook("onClose", async () => manager.closeLogins(local));

  app.get(
    "/api/v1/system/engines/auth",
    async (): Promise<{ engines: EngineAuthStatus[] }> => ({
      engines: await manager.signInStatus(local),
    })
  );

  // What a page shows for an engine's sign-in, including after a reload.
  app.get("/api/v1/system/engines/:engine/login", async (request, reply) => {
    const { engine } = request.params as { engine: string };
    if (!isLoginEngine(engine)) {
      return reply.code(404).send({ error: "No sign-in for that engine." });
    }
    const ack = await manager.currentLogin(local, engine);
    return { login: ack.ok ? ((ack.login as EngineLogin) ?? null) : null };
  });

  app.post("/api/v1/system/engines/:engine/login", async (request, reply) => {
    const { engine } = request.params as { engine: string };
    if (!isLoginEngine(engine)) {
      return reply.code(404).send({ error: "No sign-in for that engine." });
    }
    const body = startBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: "Invalid body." });
    }
    const ack = await manager.login(local, {
      type: "login_start",
      engine,
      ...body.data,
    });
    if (!ack.ok || !ack.login)
      throw new Error(ack.ok ? "No sign-in." : ack.error);
    return { login: ack.login as EngineLogin } satisfies {
      login: EngineLogin;
    };
  });

  app.get("/api/v1/system/engines/logins/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    return answer(
      reply,
      await manager.login(local, { type: "login_status", loginId: id })
    );
  });

  app.post("/api/v1/system/engines/logins/:id/code", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = codeBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: "Paste the code to continue." });
    }
    return answer(
      reply,
      await manager.login(local, {
        type: "login_submit",
        loginId: id,
        code: body.data.code,
      })
    );
  });

  app.delete("/api/v1/system/engines/logins/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    return answer(
      reply,
      await manager.login(local, { type: "login_cancel", loginId: id })
    );
  });
}
