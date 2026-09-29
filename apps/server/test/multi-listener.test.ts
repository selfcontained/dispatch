import { afterEach, expect, it } from "vitest";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { createServer } from "node:net";
import {
  listenAdditionalHosts,
  parseListenHosts,
} from "../src/multi-listener.js";
import { serverOrigin } from "../src/server-origin.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
it("validates explicit address sets and preserves internal agent reachability", () => {
  expect(parseListenHosts(undefined)).toBeUndefined();
  expect(parseListenHosts("127.0.0.1,::1,100.64.0.2")).toEqual([
    "127.0.0.1",
    "::1",
    "100.64.0.2",
  ]);
  for (const value of [
    "",
    "example.com",
    "127.0.0.1,",
    "0.0.0.0,127.0.0.1",
    "::,::1",
    "::1,::1",
  ])
    expect(() => parseListenHosts(value)).toThrow();
  expect(serverOrigin({ port: 7000, tls: null, listenHosts: ["::1"] })).toBe(
    "http://[::1]:7000"
  );
  expect(
    serverOrigin({ port: 7000, tls: null, listenHosts: ["100.64.0.2"] })
  ).toBe("http://100.64.0.2:7000");
});
it("serves the same routes and authentication hooks on each selected address", async () => {
  const app = Fastify();
  cleanup.push(() => app.close());
  await app.register(websocket);
  app.addHook("onRequest", async (request, reply) => {
    if (
      request.headers.authorization !== "Bearer test" &&
      request.url !== "/socket?token=test"
    )
      return reply.code(401).send();
  });
  app.get("/hello", async () => ({ ok: true }));
  app.get("/socket", { websocket: true }, (socket) =>
    socket.on("message", (data) => socket.send(data.toString()))
  );
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as { port: number }).port;
  const close = await listenAdditionalHosts(app, ["::1"], port);
  cleanup.push(close);
  for (const host of ["127.0.0.1", "[::1]"]) {
    expect((await fetch(`http://${host}:${port}/hello`)).status).toBe(401);
    expect(
      await (
        await fetch(`http://${host}:${port}/hello`, {
          headers: { authorization: "Bearer test" },
        })
      ).json()
    ).toEqual({ ok: true });
  }
  const client = new WebSocket(`ws://[::1]:${port}/socket?token=test`);
  await new Promise<void>((resolve, reject) => {
    client.onerror = () => reject(new Error("WebSocket failed"));
    client.onopen = () => client.send("echo");
    client.onmessage = (event) => {
      expect(event.data).toBe("echo");
      resolve();
    };
  });
  const disconnected = new Promise<void>((resolve) => {
    client.onclose = () => resolve();
  });
  await close();
  await disconnected;
  await expect(fetch(`http://[::1]:${port}/hello`)).rejects.toThrow();
});
it("rolls back other new listeners when a selected address is occupied", async () => {
  const app = Fastify();
  cleanup.push(() => app.close());
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as { port: number }).port;
  await expect(
    listenAdditionalHosts(app, ["::1", "127.0.0.1"], port)
  ).rejects.toThrow();
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen({ host: "::1", port, ipv6Only: true }, resolve);
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
});
