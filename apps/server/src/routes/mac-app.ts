import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as z from "zod/v4";
import {
  MAC_APP_UPDATE_ACTIONS,
  MAC_APP_UPDATE_PHASES,
} from "@dispatch/shared";

import { tokensEqual } from "../auth.js";
import type { MacAppUpdateBridge } from "../mac-app-update-bridge.js";
import { parseInput } from "../shared/lib/parse-input.js";

declare module "fastify" {
  interface FastifyContextConfig {
    /** Route authenticates with the menu app's per-launch control token. */
    macAppBearer?: boolean;
  }
}

const StateBodySchema = z.object({
  version: z.string().min(1).max(64),
  phase: z.enum(MAC_APP_UPDATE_PHASES),
  availableVersion: z.string().min(1).max(64).nullable(),
  checkedAt: z.iso.datetime({ offset: true }).nullable(),
  error: z.string().max(2000).nullable(),
  automatic: z.boolean(),
});

const ActionBodySchema = z.object({ action: z.enum(MAC_APP_UPDATE_ACTIONS) });

type MacAppRouteDeps = {
  bridge: MacAppUpdateBridge;
  /** DISPATCH_MAC_APP_TOKEN, written by the app's server worker each launch. */
  controlToken: string;
};

function requireControlToken(
  token: string,
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void
): void {
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ") && tokensEqual(header.slice(7), token)) {
    done();
    return;
  }
  void reply.code(401).send({ error: "Authentication required." });
}

export async function registerMacAppRoutes(
  app: FastifyInstance,
  deps: MacAppRouteDeps
): Promise<void> {
  const appOnly = {
    config: { macAppBearer: true },
    preHandler: (
      request: FastifyRequest,
      reply: FastifyReply,
      done: () => void
    ) => requireControlToken(deps.controlToken, request, reply, done),
  };

  app.get("/api/v1/mac-app/control", appOnly, (_request, reply) => {
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.hijack();
    const stream = reply.raw;
    const detach = deps.bridge.attach(stream);
    // Tells the app its connection is registered, so its state report counts.
    stream.write(`data: ${JSON.stringify({ type: "ready" })}\n\n`);
    const heartbeat = setInterval(
      () => stream.write(": keepalive\n\n"),
      20_000
    );
    stream.on("close", () => {
      clearInterval(heartbeat);
      detach();
    });
  });

  app.post("/api/v1/mac-app/state", appOnly, async (request, reply) => {
    const state = parseInput(StateBodySchema, request.body, reply);
    if (!state) return;
    if (!deps.bridge.report(state)) {
      return reply.code(409).send({ error: "No control connection is open." });
    }
    return { ok: true };
  });

  app.get("/api/v1/mac-app/update", async () => deps.bridge.snapshot());

  app.post("/api/v1/mac-app/update", async (request, reply) => {
    const input = parseInput(ActionBodySchema, request.body, reply);
    if (!input) return;
    const phase = deps.bridge.snapshot().state?.phase;
    if (phase === "installing" || phase === "recovery") {
      return reply
        .code(409)
        .send({ error: "The Mac app is already installing an update." });
    }
    if (!deps.bridge.send(input.action)) {
      return reply.code(409).send({
        error:
          "The Dispatch menu bar app isn’t running on this Mac. Open Dispatch on the Mac, then try again.",
      });
    }
    return reply.code(202).send({ ok: true });
  });
}
