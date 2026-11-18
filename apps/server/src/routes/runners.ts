import type { FastifyInstance, FastifyReply } from "fastify";
import {
  RunnerRequestError,
  type RemoteRunnerService,
} from "../agents/remote/service.js";

type RunnerRouteDeps = { runners?: RemoteRunnerService };

function hostHint(host: string | undefined) {
  if (!host) return undefined;
  try {
    return new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return undefined;
  }
}

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof RunnerRequestError)
    return reply.code(error.status).send({ error: error.message });
  throw error;
}

/**
 * Runner enrollment control API. These are ordinary /api routes, so the
 * global auth hook protects them like every other control route.
 */
export async function registerRunnerRoutes(
  app: FastifyInstance,
  deps: RunnerRouteDeps
): Promise<void> {
  for (const base of ["/api/runners", "/api/v1/runners"]) {
    app.get(base, async () => ({
      runners: (await deps.runners?.list()) ?? [],
    }));

    app.post(base, async (request, reply) => {
      if (!deps.runners)
        return reply
          .code(409)
          .send({ error: "Runner enrollment is disabled." });
      const body = (request.body ?? {}) as { name?: unknown };
      try {
        return reply
          .code(201)
          .send(
            await deps.runners.createRegistration(
              body.name,
              hostHint(request.headers.host)
            )
          );
      } catch (error) {
        return fail(reply, error);
      }
    });

    // Renew or re-key: a new one-time pairing command for the same id.
    app.post(`${base}/:id/pair`, async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!deps.runners)
        return reply.code(404).send({ error: "Runner not found." });
      try {
        return reply
          .code(201)
          .send(
            await deps.runners.reissueRegistration(
              id,
              hostHint(request.headers.host)
            )
          );
      } catch (error) {
        return fail(reply, error);
      }
    });

    app.delete(`${base}/:id`, async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!deps.runners)
        return reply.code(404).send({ error: "Runner not found." });
      try {
        await deps.runners.revoke(id);
        return { ok: true };
      } catch (error) {
        return fail(reply, error);
      }
    });
  }
}
