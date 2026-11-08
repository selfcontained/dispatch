import type { FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import type { RoutingShadowStore } from "../chat/routing-shadow.js";

/** Dedicated bearer-only diagnostic export, including during first-run mode. */
export async function registerRoutingShadowRoutes(
  app: FastifyInstance,
  store: RoutingShadowStore,
  authToken: string
) {
  app.get("/api/v1/experiments/routing-shadow", async (request, reply) => {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (
      !token ||
      !authToken ||
      Buffer.byteLength(token) !== Buffer.byteLength(authToken) ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(authToken))
    )
      return reply.code(401).send({ error: "Authentication required." });
    const { before, format } = request.query as {
      before?: string;
      format?: string;
    };
    if (
      (before !== undefined &&
        (!/^\d+$/.test(before) ||
          !Number.isSafeInteger(Number(before)) ||
          Number(before) <= 0)) ||
      (format !== undefined && format !== "jsonl")
    )
      return reply.code(400).send({
        error:
          "Use a positive integer before cursor and optional format=jsonl.",
      });
    const records = await store.read(before ? Number(before) : undefined);
    reply.header("Cache-Control", "no-store");
    if (format === "jsonl")
      return reply
        .type("application/x-ndjson")
        .send(
          records.map((r) => JSON.stringify(r)).join("\n") +
            (records.length ? "\n" : "")
        );
    return {
      records,
      nextBefore:
        records.length === 200 ? records[records.length - 1]!.turn_id : null,
    };
  });
}
