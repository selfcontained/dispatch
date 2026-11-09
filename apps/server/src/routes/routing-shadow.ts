import {
  RoutingSettings,
  TokenValidationError,
} from "../chat/routing-settings.js";
import type { RoutingShadow } from "../chat/routing-shadow.js";
import * as z from "zod/v4";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import type { RoutingShadowStore } from "../chat/routing-shadow.js";

/** Classify rejected input without echoing any credential characters. */
export function routingInputError(body: unknown): string {
  const key =
    body && typeof body === "object"
      ? (body as { apiKey?: unknown }).apiKey
      : undefined;
  if (typeof key === "string") {
    const candidate = key.trim();
    const prefix = "Token format rejected before contacting OpenAI: ";
    if (candidate.length < 10)
      return (
        prefix +
        "too short (minimum 10 characters). Paste the complete API key."
      );
    if (candidate.length > 2048)
      return (
        prefix + "too long (maximum 2048 characters). Paste only the API key."
      );
    if (/\s/.test(candidate))
      return (
        prefix +
        "contains whitespace or line breaks. Paste only the API key without a Bearer prefix."
      );
    if (!/^[\x21-\x7e]+$/.test(candidate))
      return (
        prefix +
        "contains hidden, control, or non-ASCII characters. Copy the API key again."
      );
  }
  return "Invalid settings request. Provide a valid mode, API key, or removeKey action without conflicting or unknown fields.";
}

/** Dedicated bearer-only diagnostic export, including during first-run mode. */
export async function registerRoutingShadowRoutes(
  app: FastifyInstance,
  store: RoutingShadowStore,
  authToken: string,
  settings?: RoutingSettings,
  experiment?: RoutingShadow,
  authorize?: (request: FastifyRequest) => Promise<boolean>,
  publish?: (event: import("@dispatch/shared").SharedUiEvent) => void
) {
  if (settings && experiment) {
    const privateRoute = {
      preHandler: async (
        request: FastifyRequest,
        reply: import("fastify").FastifyReply
      ) => {
        if (!authorize || !(await authorize(request)))
          return reply.code(403).send({
            error:
              "Set a password and sign in, or use the server bearer token, to manage AI routing.",
          });
      },
    };
    app.get(
      "/api/v1/experiments/routing/pending",
      privateRoute,
      async (request, reply) => {
        const { streamId } = request.query as { streamId?: string };
        reply.header("Cache-Control", "no-store");
        if (typeof streamId !== "string" || streamId.length > 200)
          return reply.code(400).send({ error: "streamId is required." });
        const config = await settings.configuration();
        return {
          pending:
            config.mode === "active" && config.apiKey
              ? experiment.pending(streamId)
              : [],
        };
      }
    );
    app.get(
      "/api/v1/experiments/routing/settings",
      privateRoute,
      async (_request, reply) => {
        reply.header("Cache-Control", "no-store");
        return settings.status();
      }
    );
    app.put(
      "/api/v1/experiments/routing/settings",
      { ...privateRoute, bodyLimit: 8192 },
      async (request, reply) => {
        const parsed = z
          .object({
            mode: z.enum(["off", "active"]).optional(),
            aiEnabled: z.boolean().optional(),
            steeringMode: z.enum(["off", "active"]).optional(),
            mergeRiskMode: z.enum(["off", "active"]).optional(),
            apiKey: z
              .string()
              .trim()
              .min(10)
              .max(2048)
              .regex(/^[\x21-\x7e]+$/)
              .optional(),
            removeKey: z.boolean().optional(),
          })
          .strict()
          .safeParse(request.body);
        if (!parsed.success || (parsed.data.apiKey && parsed.data.removeKey))
          return reply.code(400).send({
            error: routingInputError(request.body),
          });
        reply.header("Cache-Control", "no-store");
        const saved = await settings.save(parsed.data).catch((error) => {
          if (error instanceof TokenValidationError) {
            reply.code(422).send({ error: error.message });
            return null;
          }
          throw error;
        });
        if (!saved) return;
        if (saved.mode !== "active" || !saved.configured)
          experiment.cancelAll();
        publish?.({
          type: "routing.config_changed",
          mode: saved.mode,
          configured: saved.configured,
        });
        return saved;
      }
    );
    app.post(
      "/api/v1/experiments/routing/check",
      { ...privateRoute, bodyLimit: 8192 },
      async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        const parsed = z
          .object({
            apiKey: z
              .string()
              .trim()
              .min(10)
              .max(2048)
              .regex(/^[\x21-\x7e]+$/)
              .optional(),
          })
          .strict()
          .safeParse(request.body ?? {});
        if (!parsed.success)
          return reply.code(400).send({
            error: routingInputError(request.body),
          });
        return settings.check(parsed.data.apiKey);
      }
    );
  }
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
        (!/^-?\d+$/.test(before) ||
          !Number.isSafeInteger(Number(before)) ||
          Number(before) === 0)) ||
      (format !== undefined && format !== "jsonl")
    )
      return reply.code(400).send({
        error: "Use a nonzero integer before cursor and optional format=jsonl.",
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
