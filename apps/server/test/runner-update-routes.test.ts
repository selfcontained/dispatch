import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RunnerUpdateIneligible } from "../src/agents/remote/update-coordinator.js";
import { registerRunnerRoutes } from "../src/routes/runners.js";

let app: ReturnType<typeof Fastify> | undefined;
afterEach(async () => {
  await app?.close();
});

const runner = (id: string, status: string) => ({
  id,
  name: id,
  status,
  workspaces: [],
});

async function routes() {
  const updates = {
    setAutomatic: vi.fn(async () => {}),
    request: vi.fn(async () => ({ attemptId: "attempt" })),
    forceUpdate: vi.fn(async () => ({ attemptId: "forced" })),
    view: vi.fn((id: string) =>
      id === "plain"
        ? undefined
        : { available: { version: "1.2.3", action: "update" } }
    ),
  };
  app = Fastify();
  app.addHook("onRequest", async (request, reply) => {
    if (
      request.method === "PATCH" &&
      request.headers.authorization !== "Bearer test"
    )
      return reply.code(401).send();
  });
  await registerRunnerRoutes(app, {
    runners: {
      list: async () => [
        runner("capable", "online"),
        runner("plain", "online"),
        runner("gone", "revoked"),
      ],
    } as never,
    updates: updates as never,
  });
  return { app, updates };
}

describe("runner update routes", () => {
  it("requires auth and a boolean to change a runner's update policy", async () => {
    const { app, updates } = await routes();
    const patch = (payload: object, auth: boolean) =>
      app.inject({
        method: "PATCH",
        url: "/api/v1/runners/capable/update-policy",
        headers: auth ? { authorization: "Bearer test" } : {},
        payload,
      });
    expect((await patch({ automatic: false }, false)).statusCode).toBe(401);
    expect((await patch({ automatic: "false" }, true)).statusCode).toBe(400);
    expect(updates.setAutomatic).not.toHaveBeenCalled();
    expect((await patch({ automatic: false }, true)).json()).toEqual({
      automatic: false,
    });
    expect(updates.setAutomatic).toHaveBeenCalledWith("capable", false);
  });

  it("returns the attempt", async () => {
    const { app, updates } = await routes();
    const reply = await app.inject({
      method: "POST",
      url: "/api/v1/runners/capable/update",
      payload: { action: "retry" },
    });
    expect(reply.statusCode).toBe(202);
    expect(reply.json()).toEqual({ attemptId: "attempt" });
    expect(updates.request).toHaveBeenCalledWith("capable", "retry");
  });

  it("returns an eligibility error with its code and the attempt in the way", async () => {
    const { app, updates } = await routes();
    updates.request.mockRejectedValueOnce(
      new RunnerUpdateIneligible("update_in_progress", "running")
    );
    const reply = await app.inject({
      method: "POST",
      url: "/api/v1/runners/capable/update",
      payload: { action: "update" },
    });
    expect(reply.statusCode).toBe(409);
    expect(reply.json()).toEqual({
      error: "An update is already running on this runner.",
      code: "update_in_progress",
      attemptId: "running",
    });
  });

  it.each([undefined, "waiting"])(
    "forces only when asked to, with attempt %s",
    async (attemptId) => {
      const { app, updates } = await routes();
      const post = (action: string) =>
        app.inject({
          method: "POST",
          url: "/api/v1/runners/capable/update",
          payload: { action, attemptId },
        });
      await post("update");
      expect(updates.forceUpdate).not.toHaveBeenCalled();
      const reply = await post("force");
      expect(reply.statusCode).toBe(202);
      expect(reply.json()).toEqual({ attemptId: "forced" });
      expect(updates.forceUpdate).toHaveBeenCalledWith("capable", attemptId);
      expect(updates.request).toHaveBeenCalledTimes(1);
    }
  );

  it("refuses a malformed force", async () => {
    const { app, updates } = await routes();
    const reply = await app.inject({
      method: "POST",
      url: "/api/v1/runners/capable/update",
      payload: { action: "force", attemptId: 7 },
    });
    expect(reply.statusCode).toBe(400);
    expect(updates.forceUpdate).not.toHaveBeenCalled();
  });

  it("adds update state only where there is any", async () => {
    const { app } = await routes();
    const { runners } = (await app.inject("/api/v1/runners")).json();
    expect(runners).toEqual([
      {
        ...runner("capable", "online"),
        update: { available: { version: "1.2.3", action: "update" } },
      },
      runner("plain", "online"),
      runner("gone", "revoked"),
    ]);
  });
});
