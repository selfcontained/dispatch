import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { FocusTracker } from "../src/focus-tracker.js";
import { registerAgentEventRoutes } from "../src/routes/agents/events-routes.js";
import type { AgentRouteDeps } from "../src/routes/agents/shared.js";

async function setup() {
  const focus = new FocusTracker();
  const beats: unknown[] = [];
  const app = Fastify();
  await registerAgentEventRoutes(app, {
    clearFocusedAgents: () => focus.clearAll(),
    setFocusedAgent: (id: string) => focus.setFocused(id),
    reportPresence: (sessionId: string, beat: unknown) =>
      beats.push({ sessionId, ...(beat as object) }),
  } as unknown as AgentRouteDeps);
  const beat = (body: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/v1/focus", payload: body });
  return { focus, beats, beat };
}

describe("POST /api/v1/focus", () => {
  it("moves focus from one agent to the next without a null beat between", async () => {
    const { focus, beat } = await setup();
    const presence = {
      sessionId: "ses_route-test-1",
      visible: true,
      idleMs: 0,
    };
    await beat({ agentId: "agt_a", viewingAgentId: "agt_a", ...presence });
    expect(focus.isFocused("agt_a")).toBe(true);
    await beat({ agentId: "agt_b", viewingAgentId: "agt_b", ...presence });
    expect(focus.isFocused("agt_a")).toBe(false);
    expect(focus.isFocused("agt_b")).toBe(true);
  });

  it("records presence carried on the beat", async () => {
    const { beats, beat } = await setup();
    const res = await beat({
      agentId: null,
      sessionId: "ses_route-test-1",
      visible: false,
      idleMs: 5,
      viewingAgentId: "agt_a",
    });
    expect(res.statusCode).toBe(204);
    expect(beats).toEqual([
      {
        sessionId: "ses_route-test-1",
        visible: false,
        idleMs: 5,
        viewingAgentId: "agt_a",
      },
    ]);
  });
});
