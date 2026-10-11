import type { FastifyInstance } from "fastify";
import * as z from "zod/v4";

import type { EngineAuthStatus, EngineLogin } from "@dispatch/shared";

import {
  EngineLogins,
  LOGIN_ENGINES,
  isLoginEngine,
} from "../agents/engine-login.js";

const startBodySchema = z.object({ restart: z.boolean().optional() });
const codeBodySchema = z.object({ code: z.string().min(1).max(2000) });

/**
 * Engine sign-in from the browser: whether each engine's CLI is signed in,
 * and a login the server runs for it (see EngineLogins).
 */
export async function registerEngineLoginRoutes(
  app: FastifyInstance,
  logins: EngineLogins
): Promise<void> {
  app.addHook("onClose", async () => logins.close());

  app.get(
    "/api/v1/system/engines/auth",
    async (): Promise<{ engines: EngineAuthStatus[] }> => ({
      engines: await Promise.all(
        LOGIN_ENGINES.map((engine) => logins.status(engine))
      ),
    })
  );

  // What a page shows for an engine's sign-in, including after a reload.
  app.get("/api/v1/system/engines/:engine/login", async (request, reply) => {
    const { engine } = request.params as { engine: string };
    if (!isLoginEngine(engine)) {
      return reply.code(404).send({ error: "No sign-in for that engine." });
    }
    return { login: logins.current(engine) };
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
    const login = await logins.start(engine, body.data);
    return { login } satisfies { login: EngineLogin };
  });

  app.get("/api/v1/system/engines/logins/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const login = logins.get(id);
    if (!login) return reply.code(404).send({ error: "Sign-in not found." });
    return { login };
  });

  app.post("/api/v1/system/engines/logins/:id/code", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = codeBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: "Paste the code to continue." });
    }
    const login = logins.submitCode(id, body.data.code);
    if (!login) return reply.code(404).send({ error: "Sign-in not found." });
    return { login };
  });

  app.delete("/api/v1/system/engines/logins/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const login = logins.cancel(id);
    if (!login) return reply.code(404).send({ error: "Sign-in not found." });
    return { login };
  });
}
