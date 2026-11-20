import type { FastifyInstance, FastifyReply } from "fastify";
import {
  RunnerRequestError,
  type RemoteRunnerService,
} from "../agents/remote/service.js";

type RunnerRouteDeps = { runners?: RemoteRunnerService };

declare module "fastify" {
  interface FastifyContextConfig {
    /**
     * Runner-initiated enrollment create/poll: no Dispatch credentials
     * exist yet, so the route gates itself (code, attempts, rate limit)
     * instead of going through the global auth hook.
     */
    runnerConnectBootstrap?: boolean;
  }
}

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
    app.get(base, async (request) => {
      const { includeCleared } = request.query as { includeCleared?: string };
      return {
        runners: (await deps.runners?.list(includeCleared === "true")) ?? [],
      };
    });

    app.post(`${base}/revoked/clear`, async (request, reply) => {
      const { ids } = (request.body ?? {}) as { ids?: unknown };
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string"))
        return reply.code(400).send({ error: "Runner IDs are required." });
      return { cleared: (await deps.runners?.clearRevoked(ids)) ?? 0 };
    });

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

    // Runner-initiated ("connect") enrollment. The create and poll routes
    // carry no Dispatch credentials — the runner has none yet — so they
    // are exempted from the global auth hook by `runnerConnectBootstrap`
    // (see server.ts) and rate-limited instead. Approve and deny are
    // ordinary authenticated control routes, like every route above.
    app.post(
      `${base}/connect`,
      {
        config: {
          runnerConnectBootstrap: true,
          rateLimit: { max: 20, timeWindow: "1 minute" },
        },
      },
      async (request, reply) => {
        if (!deps.runners)
          return reply
            .code(409)
            .send({ error: "Runner enrollment is disabled." });
        const body = (request.body ?? {}) as { publicKey?: unknown };
        try {
          return reply
            .code(201)
            .send(await deps.runners.createConnectRequest(body.publicKey));
        } catch (error) {
          return fail(reply, error);
        }
      }
    );

    // The authenticated operator's copy of the invocation to run on a
    // runner — always reachable even when the ordinary API is loopback or
    // plain HTTP, since it targets the runner listener's own pinned CA.
    app.get(`${base}/connect-command`, async (request, reply) => {
      if (!deps.runners)
        return reply
          .code(409)
          .send({ error: "Runner enrollment is disabled." });
      try {
        return await deps.runners.connectCommand(
          hostHint(request.headers.host)
        );
      } catch (error) {
        return fail(reply, error);
      }
    });

    app.get(
      `${base}/connect/:id`,
      {
        config: {
          runnerConnectBootstrap: true,
          rateLimit: { max: 60, timeWindow: "1 minute" },
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        if (!deps.runners)
          return reply
            .code(409)
            .send({ error: "Runner enrollment is disabled." });
        try {
          return await deps.runners.pollConnectRequest(id);
        } catch (error) {
          return fail(reply, error);
        }
      }
    );

    app.get(`${base}/connect`, async () => ({
      requests: (await deps.runners?.listConnectRequests()) ?? [],
    }));

    app.post(`${base}/connect/:id/approve`, async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!deps.runners)
        return reply.code(404).send({ error: "Connect request not found." });
      const body = (request.body ?? {}) as {
        code?: unknown;
        name?: unknown;
      };
      try {
        return reply
          .code(201)
          .send(
            await deps.runners.approveConnectRequest(
              id,
              body.code,
              body.name,
              hostHint(request.headers.host)
            )
          );
      } catch (error) {
        return fail(reply, error);
      }
    });

    app.delete(`${base}/connect/:id`, async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!deps.runners)
        return reply.code(404).send({ error: "Connect request not found." });
      try {
        await deps.runners.denyConnectRequest(id);
        return { ok: true };
      } catch (error) {
        return fail(reply, error);
      }
    });
  }
}
