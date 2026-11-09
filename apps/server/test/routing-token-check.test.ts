import { expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { RoutingSettings } from "../src/chat/routing-settings.js";

it.each([401, 403, 404, 429, 500])(
  "sanitizes HTTP %s and prevents persistence",
  async (status) => {
    const connect = vi.fn();
    const transport = vi.fn(
      async () =>
        new Response('{"error":{"message":"secret-token"}}', { status })
    );
    const settings = new RoutingSettings(
      { connect } as unknown as Pool,
      {},
      transport
    );
    expect(await settings.check("secret-token")).toMatchObject({
      status: "provider_error",
      message: expect.stringContaining(String(status)),
    });
    await expect(settings.save({ apiKey: "secret-token" })).rejects.toThrow(
      String(status)
    );
    expect(connect).not.toHaveBeenCalled();
    expect(JSON.stringify(await settings.check("secret-token"))).not.toContain(
      "secret-token"
    );
  }
);
it("checks the exact candidate with a non-generating request", async () => {
  const transport = vi.fn(async () => new Response("{}"));
  const settings = new RoutingSettings({} as Pool, {}, transport);
  expect(await settings.check("candidate")).toMatchObject({ status: "ok" });
  expect(transport.mock.calls[0]).toMatchObject([
    "https://api.openai.com/v1/models/gpt-6-luna",
    { headers: { Authorization: "Bearer candidate" } },
  ]);
});
it("sanitizes network exceptions and blocks writes", async () => {
  const connect = vi.fn();
  const settings = new RoutingSettings(
    { connect } as unknown as Pool,
    {},
    async () => {
      throw new Error("secret-token");
    }
  );
  await expect(settings.save({ apiKey: "secret-token" })).rejects.toThrow(
    "network"
  );
  expect(connect).not.toHaveBeenCalled();
});
