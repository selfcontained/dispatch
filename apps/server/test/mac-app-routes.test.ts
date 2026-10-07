import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MacAppUpdateBridge } from "../src/mac-app-update-bridge.js";
import { registerMacAppRoutes } from "../src/routes/mac-app.js";
import type { UiEvent } from "../src/server/ui-events.js";

const TOKEN = "a".repeat(64);
const STATE = {
  version: "1.0.1",
  phase: "idle",
  availableVersion: "1.0.2",
  checkedAt: "2026-10-01T12:00:00.000Z",
  error: null,
  automatic: false,
};

let app: FastifyInstance;
let base: string;
let events: UiEvent[];
const controllers: AbortController[] = [];

beforeEach(async () => {
  events = [];
  app = Fastify();
  await registerMacAppRoutes(app, {
    bridge: new MacAppUpdateBridge((event) => events.push(event)),
    controlToken: TOKEN,
  });
  base = await app.listen({ host: "127.0.0.1", port: 0 });
});

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  await app.close();
});

/** Opens the control stream and returns a reader of its `data:` events. */
async function connect(token = TOKEN) {
  const controller = new AbortController();
  controllers.push(controller);
  const response = await fetch(`${base}/api/v1/mac-app/control`, {
    headers: { authorization: `Bearer ${token}` },
    signal: controller.signal,
  });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  async function next(): Promise<Record<string, unknown>> {
    for (;;) {
      const match = /^data: (.*)\n\n/m.exec(buffered);
      if (match) {
        buffered = buffered.slice(match.index + match[0].length);
        return JSON.parse(match[1]) as Record<string, unknown>;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("stream closed");
      buffered += decoder.decode(value, { stream: true });
    }
  }
  return { response, next, close: () => controller.abort() };
}

function postState(body: unknown, token = TOKEN) {
  return app.inject({
    method: "POST",
    url: "/api/v1/mac-app/state",
    headers: { authorization: `Bearer ${token}` },
    payload: body as Record<string, unknown>,
  });
}

describe("mac app control routes", () => {
  it("rejects the control stream and state reports without the app token", async () => {
    const stream = await fetch(`${base}/api/v1/mac-app/control`, {
      headers: { authorization: `Bearer ${"b".repeat(64)}` },
    });
    expect(stream.status).toBe(401);
    const state = await postState(STATE, "b".repeat(64));
    expect(state.statusCode).toBe(401);
  });

  it("reports disconnected and refuses commands when no app is connected", async () => {
    const snapshot = await app.inject({
      method: "GET",
      url: "/api/v1/mac-app/update",
    });
    expect(snapshot.json()).toEqual({ connected: false, state: null });
    const command = await app.inject({
      method: "POST",
      url: "/api/v1/mac-app/update",
      payload: { action: "check" },
    });
    expect(command.statusCode).toBe(409);
    expect(command.json().error).toMatch(/isn’t running/);
    expect((await postState(STATE)).statusCode).toBe(409);
  });

  it("relays commands to the app and its state back to the web app", async () => {
    const control = await connect();
    expect(control.response.status).toBe(200);
    expect(await control.next()).toEqual({ type: "ready" });

    expect((await postState(STATE)).statusCode).toBe(200);
    const snapshot = await app.inject({
      method: "GET",
      url: "/api/v1/mac-app/update",
    });
    expect(snapshot.json()).toEqual({ connected: true, state: STATE });
    expect(events.at(-1)).toEqual({
      type: "mac_app.update_changed",
      update: { connected: true, state: STATE },
    });

    const command = await app.inject({
      method: "POST",
      url: "/api/v1/mac-app/update",
      payload: { action: "install" },
    });
    expect(command.statusCode).toBe(202);
    expect(await control.next()).toMatchObject({
      type: "command",
      action: "install",
    });
  });

  it("refuses new commands while an install is in progress", async () => {
    const control = await connect();
    await control.next();
    await postState({ ...STATE, phase: "installing" });
    const command = await app.inject({
      method: "POST",
      url: "/api/v1/mac-app/update",
      payload: { action: "check" },
    });
    expect(command.statusCode).toBe(409);
    expect(command.json().error).toMatch(/already installing/);
  });

  it("rejects malformed state and unknown actions", async () => {
    const control = await connect();
    await control.next();
    expect((await postState({ ...STATE, phase: "exploding" })).statusCode).toBe(
      400
    );
    const command = await app.inject({
      method: "POST",
      url: "/api/v1/mac-app/update",
      payload: { action: "uninstall" },
    });
    expect(command.statusCode).toBe(400);
  });

  it("clears state when the app disconnects, and a newer connection replaces an older one", async () => {
    const first = await connect();
    await first.next();
    await postState(STATE);

    const second = await connect();
    await second.next();
    // The replaced stream is ended by the server.
    await expect(first.next()).rejects.toThrow();
    expect(
      (
        await app.inject({ method: "GET", url: "/api/v1/mac-app/update" })
      ).json()
    ).toMatchObject({ connected: true });

    second.close();
    await expect
      .poll(async () =>
        (
          await app.inject({ method: "GET", url: "/api/v1/mac-app/update" })
        ).json()
      )
      .toEqual({ connected: false, state: null });
  });
});
