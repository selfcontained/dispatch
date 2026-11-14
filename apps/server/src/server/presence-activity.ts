import type { FastifyInstance } from "fastify";

import {
  isActivityRequest,
  PRESENCE_SESSION_HEADER,
  type PresenceTracker,
} from "../presence-tracker.js";

/** A successful chat action from an app session marks that session active. */
export function registerPresenceActivity(
  app: FastifyInstance,
  presence: Pick<PresenceTracker, "noteActivity">
): void {
  app.addHook("onResponse", async (request, reply) => {
    const sessionId = request.headers[PRESENCE_SESSION_HEADER];
    if (typeof sessionId !== "string" || reply.statusCode >= 400) return;
    const route = request.routeOptions.url;
    if (route && isActivityRequest(request.method, route))
      presence.noteActivity(sessionId);
  });
}
