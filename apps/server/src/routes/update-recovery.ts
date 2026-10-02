import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  RECOVERY_ROUTE_PREFIX,
  challengeSchema,
  fenceBody,
  abortBody,
  readinessBody,
  isLoopbackAddress,
  recoveryProof,
  safeEqual,
} from "../update-recovery/protocol.js";
import { readRecoveryKey } from "../update-recovery/control.js";
import type { RecoveryMaintenance } from "../update-recovery/maintenance.js";
declare module "fastify" {
  interface FastifyContextConfig {
    updateRecovery?: boolean;
  }
}
export async function registerUpdateRecoveryRoutes(
  app: FastifyInstance,
  deps: {
    maintenance: RecoveryMaintenance;
    keyFile: string;
    /**
     * Another per-installation secret held only by the local supervisor (the
     * Mac menu app's control token). It doubles as the proof key.
     */
    alternateKey?: () => string | null;
  }
): Promise<void> {
  const { maintenance } = deps;

  // Resolve the key and reject anything not from an enrolled local helper.
  async function authorize(
    request: FastifyRequest
  ): Promise<{ key: Buffer } | { status: number; code: string }> {
    if (!isLoopbackAddress(request.socket.remoteAddress))
      return { status: 403, code: "NOT_LOCAL" };
    const key = await readRecoveryKey(deps.keyFile);
    const alternate = deps.alternateKey?.() ?? null;
    if (!key && !alternate)
      return { status: 503, code: "RECOVERY_NOT_ENROLLED" };
    const header = request.headers.authorization ?? "";
    const presented = header.startsWith("Dispatch-Recovery ")
      ? header.slice("Dispatch-Recovery ".length).trim()
      : "";
    if (presented && key && safeEqual(presented, key.toString("utf8")))
      return { key };
    if (presented && alternate && safeEqual(presented, alternate))
      return { key: Buffer.from(alternate, "utf8") };
    return { status: 401, code: "UNAUTHORIZED" };
  }

  const config = { updateRecovery: true };
  const route = (name: string) => `${RECOVERY_ROUTE_PREFIX}${name}`;

  function signed(
    key: Buffer,
    name: string,
    challenge: string,
    body: Record<string, unknown>,
    secret?: Record<string, string>
  ) {
    return {
      ...body,
      proof: recoveryProof(key, route(name), challenge, body, secret),
    };
  }

  app.get(route("status"), { config }, async (request, reply) => {
    const auth = await authorize(request);
    if (!("key" in auth)) return reply.code(auth.status).send(auth);
    const challenge = challengeSchema.safeParse(
      (request.query as { challenge?: unknown }).challenge
    );
    if (!challenge.success)
      return reply.code(400).send({ code: "INVALID_REQUEST" });
    return signed(auth.key, "status", challenge.data, {
      ...maintenance.status(),
      ...maintenance.identity(),
    });
  });

  app.post(route("fence"), { config }, async (request, reply) => {
    const auth = await authorize(request);
    if (!("key" in auth)) return reply.code(auth.status).send(auth);
    const body = fenceBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ code: "INVALID_REQUEST" });
    const result = await maintenance.fence(body.data);
    if (!result.ok) {
      return reply.code(result.status).send(
        signed(auth.key, "fence", body.data.challenge, {
          code: result.code,
          reasons: result.reasons ?? [],
        })
      );
    }
    return signed(auth.key, "fence", body.data.challenge, {
      ...(await maintenance.boundary()),
      ...maintenance.status(),
      ...maintenance.identity(),
    });
  });

  app.delete(route("fence"), { config }, async (request, reply) => {
    const auth = await authorize(request);
    if (!("key" in auth)) return reply.code(auth.status).send(auth);
    const body = abortBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ code: "INVALID_REQUEST" });
    const result = maintenance.abort(body.data.transactionId);
    const payload = result.ok
      ? { aborted: true, pid: process.pid }
      : { code: result.code };
    return reply
      .code(result.ok ? 202 : result.status)
      .send(signed(auth.key, "fence-abort", body.data.challenge, payload));
  });

  app.post(route("readiness"), { config }, async (request, reply) => {
    const auth = await authorize(request);
    if (!("key" in auth)) return reply.code(auth.status).send(auth);
    const body = readinessBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ code: "INVALID_REQUEST" });
    const result = await maintenance.readiness(body.data);
    if (!result.ok) {
      return reply.code(result.status).send(
        signed(auth.key, "readiness", body.data.challenge, {
          ready: false,
          code: result.code,
          ...(result.liveHosts ? { liveHosts: result.liveHosts } : {}),
        })
      );
    }
    return signed(
      auth.key,
      "readiness",
      body.data.challenge,
      result.body,
      result.secret
    );
  });
}
