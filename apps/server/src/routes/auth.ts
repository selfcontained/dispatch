import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";
import * as z from "zod/v4";

import type { AppConfig } from "../config.js";
import {
  changePassword,
  createSession,
  deleteAllSessions,
  deleteSession,
  setPassword,
  validateSession,
  verifyPassword,
} from "../auth.js";

const SetupBodySchema = z.object({
  password: z.string().min(8, "Password must be at least 8 characters."),
});
const LoginBodySchema = z.object({
  password: z.string().min(1, "Password is required."),
});
const ChangePasswordBodySchema = z.object({
  currentPassword: z.string().min(1, "Current password is required."),
  newPassword: z.string().min(8, "New password must be at least 8 characters."),
});

type AuthRouteDeps = {
  pool: Pool;
  tls: AppConfig["tls"];
  sessionCookie: string;
  sessionMaxAgeSeconds: number;
  isPasswordSetCached: () => Promise<boolean>;
  invalidatePasswordSetCache: () => void;
};

export async function registerAuthRoutes(
  app: FastifyInstance,
  deps: AuthRouteDeps
): Promise<void> {
  function setSessionCookie(reply: FastifyReply, token: string): void {
    reply.setCookie(deps.sessionCookie, token, {
      path: "/",
      httpOnly: true,
      signed: true,
      sameSite: "lax",
      secure: deps.tls !== null,
      maxAge: deps.sessionMaxAgeSeconds,
    });
  }

  app.get("/api/v1/auth/status", async (request) => {
    const hasPassword = await deps.isPasswordSetCached();
    let authenticated = false;
    if (hasPassword) {
      const signed = request.cookies[deps.sessionCookie];
      if (signed) {
        const unsigned = request.unsignCookie(signed);
        if (unsigned.valid && unsigned.value) {
          authenticated = await validateSession(deps.pool, unsigned.value);
        }
      }
    } else {
      authenticated = true;
    }
    return { passwordSet: hasPassword, authenticated };
  });

  app.post(
    "/api/v1/auth/setup",
    { config: { rateLimit: { max: 3, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (await deps.isPasswordSetCached()) {
        return reply.code(400).send({ error: "Password is already set." });
      }
      const parsed = SetupBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0].message });
      }

      await setPassword(deps.pool, parsed.data.password);
      deps.invalidatePasswordSetCache();

      const token = await createSession(deps.pool);
      setSessionCookie(reply, token);
      return { ok: true };
    }
  );

  app.post(
    "/api/v1/auth/login",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsed = LoginBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0].message });
      }
      if (!(await verifyPassword(deps.pool, parsed.data.password))) {
        return reply.code(401).send({ error: "Invalid password." });
      }

      const token = await createSession(deps.pool);
      setSessionCookie(reply, token);
      return { ok: true };
    }
  );

  app.post("/api/v1/auth/logout", async (request, reply) => {
    const signed = request.cookies[deps.sessionCookie];
    if (signed) {
      const unsigned = request.unsignCookie(signed);
      if (unsigned.valid && unsigned.value) {
        await deleteSession(deps.pool, unsigned.value);
      }
    }
    reply.clearCookie(deps.sessionCookie, { path: "/" });
    return { ok: true };
  });

  app.post(
    "/api/v1/auth/change-password",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsed = ChangePasswordBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0].message });
      }

      const changed = await changePassword(
        deps.pool,
        parsed.data.currentPassword,
        parsed.data.newPassword
      );
      if (!changed) {
        return reply
          .code(401)
          .send({ error: "Current password is incorrect." });
      }

      await deleteAllSessions(deps.pool);
      const token = await createSession(deps.pool);
      setSessionCookie(reply, token);
      deps.invalidatePasswordSetCache();
      return { ok: true };
    }
  );
}
