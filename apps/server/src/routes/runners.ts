import type { FastifyInstance, FastifyReply } from "fastify";
import {
  RunnerUpdateIneligible,
  type RunnerUpdateCoordinator,
} from "../agents/remote/update-coordinator.js";
import {
  RunnerRequestError,
  type RemoteRunnerService,
} from "../agents/remote/service.js";

type RunnerRouteDeps = {
  directory?: Pick<
    import("../runners/directory.js").CheckoutDirectory,
    "managementList"
  >;
  runners?: RemoteRunnerService;
  updates?: RunnerUpdateCoordinator;
};

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

export function hostHint(host: string | undefined) {
  if (!host) return undefined;
  try {
    return new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return undefined;
  }
}

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof RunnerUpdateIneligible)
    return reply.code(error.status).send({
      error: error.message,
      code: error.code,
      ...(error.attemptId && { attemptId: error.attemptId }),
    });
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
      const runners =
        (await (deps.directory?.managementList(includeCleared === "true") ??
          deps.runners?.list(includeCleared === "true"))) ?? [];
      return {
        runners: runners.map((runner) => {
          if ("kind" in runner && runner.kind === "local") return runner;
          if (!("status" in runner)) return runner;
          if (runner.status === "revoked") return runner;
          const update = deps.updates?.view(
            runner.id,
            runner.status === "offline" ? runner.health : undefined
          );
          return update ? { ...runner, update } : runner;
        }),
      };
    });

    app.patch(`${base}/:id/update-policy`, async (request, reply) => {
      const { id } = request.params as { id: string };
      const { automatic } = (request.body ?? {}) as { automatic?: unknown };
      if (typeof automatic !== "boolean")
        return reply
          .code(400)
          .send({ error: "The automatic setting must be a boolean." });
      if (!deps.updates)
        return reply.code(404).send({ error: "Runner not found." });
      try {
        await deps.updates.setAutomatic(id, automatic);
        return { automatic };
      } catch (error) {
        return fail(reply, error);
      }
    });

    app.post(`${base}/:id/update`, async (request, reply) => {
      const { id } = request.params as { id: string };
      const { action, attemptId } = (request.body ?? {}) as {
        action?: unknown;
        attemptId?: unknown;
      };
      if (action === "cancel") {
        if (typeof attemptId !== "string")
          return reply
            .code(400)
            .send({ error: "The drain attempt ID is required." });
        if (!deps.updates)
          return reply.code(404).send({ error: "Runner not found." });
        try {
          return reply
            .code(202)
            .send(await deps.updates.cancelDrain(id, attemptId));
        } catch (error) {
          return fail(reply, error);
        }
      }
      if (action === "force") {
        if (attemptId !== undefined && typeof attemptId !== "string")
          return reply
            .code(400)
            .send({ error: "The update attempt ID must be a string." });
        if (!deps.updates)
          return reply.code(404).send({ error: "Runner not found." });
        try {
          return reply
            .code(202)
            .send(await deps.updates.forceUpdate(id, attemptId));
        } catch (error) {
          return fail(reply, error);
        }
      }
      if (action !== "update" && action !== "retry")
        return reply.code(400).send({
          error: 'The action must be "update", "retry", "force", or "cancel".',
        });
      if (!deps.updates)
        return reply.code(404).send({ error: "Runner not found." });
      try {
        return reply.code(202).send(await deps.updates.request(id, action));
      } catch (error) {
        return fail(reply, error);
      }
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
