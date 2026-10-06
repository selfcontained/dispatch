import Fastify from "fastify";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import { registerStaticRoutes } from "../src/routes/static.js";
import { createStaticThemeRuntime } from "../src/server/static-theme.js";

const javascript = "export const message = 'production asset';\n".repeat(100);
const html =
  '<html><link href="/icons/teal/favicon.png">' + " ".repeat(2048) + "</html>";
const png = Buffer.alloc(2048, 42);
const asset = (
  routePath: string,
  contentType: string,
  body: string | Buffer
) => ({
  routePath,
  contentType,
  base64: Buffer.from(body).toString("base64"),
});

const servers: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((app) => app.close()));
});

async function setup() {
  const app = Fastify();
  servers.push(app);
  // Same decoded embedded-asset path used by the packaged server.
  const runtime = createStaticThemeRuntime([
    asset("/index.html", "text/html; charset=utf-8", html),
    asset(
      "/manifest.webmanifest",
      "application/manifest+json",
      JSON.stringify({ name: "Dispatch", description: "x".repeat(2048) })
    ),
    asset(
      "/assets/app-12345678.js",
      "text/javascript; charset=utf-8",
      javascript
    ),
    asset(
      "/assets/app-12345678.css",
      "text/css",
      "body { color: red; }\n".repeat(100)
    ),
    asset("/sw.js", "text/javascript", javascript),
    asset("/icon.png", "image/png", png),
    asset("/tiny.js", "text/javascript", "export {};"),
  ]);
  await registerStaticRoutes(app, runtime);
  app.get("/api/v1/events", (_, reply) =>
    reply.type("text/event-stream").send(`data: ${"x".repeat(2048)}\n\n`)
  );
  return { app, runtime };
}

describe("production static asset compression", () => {
  it.each([
    ["gzip", "gzip", gunzipSync],
    ["br, gzip", "br", brotliDecompressSync],
    ["br;q=0, gzip;q=1", "gzip", gunzipSync],
    ["br;q=0.1, gzip;q=1", "gzip", gunzipSync],
    ["identity;q=0.1, gzip;q=1", "gzip", gunzipSync],
    ["identity;q=1, br;q=1, gzip;q=1", "br", brotliDecompressSync],
  ] as const)(
    "negotiates %s and preserves the embedded JS",
    async (accept, expected, decode) => {
      const { app } = await setup();
      const response = await app.inject({
        url: "/assets/app-12345678.js?v=1",
        headers: { "accept-encoding": accept },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-encoding"]).toBe(expected);
      expect(response.headers.vary).toContain("accept-encoding");
      expect(response.headers["content-type"]).toContain("text/javascript");
      expect(decode(response.rawPayload).toString()).toBe(javascript);
      expect(response.rawPayload.length).toBeLessThan(
        Buffer.byteLength(javascript)
      );
    }
  );

  it.each([
    undefined,
    "identity",
    "br;q=0, gzip;q=0",
    "identity;q=1, br;q=0.1",
    "identity;q=1, gzip;q=0.5",
  ])("serves identity when requested: %s", async (accept) => {
    const { app } = await setup();
    const response = await app.inject({
      url: "/assets/app-12345678.js",
      headers: accept ? { "accept-encoding": accept } : {},
    });
    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.headers.vary).toContain("accept-encoding");
    expect(response.body).toBe(javascript);
  });

  it("compresses CSS and leaves small and binary assets alone", async () => {
    const { app } = await setup();
    for (const url of ["/icon.png", "/tiny.js"]) {
      const response = await app.inject({
        url,
        headers: { "accept-encoding": "br, gzip" },
      });
      expect(response.headers["content-encoding"]).toBeUndefined();
      expect(response.rawPayload).toEqual(
        url === "/icon.png" ? png : Buffer.from("export {};")
      );
    }
    const css = await app.inject({
      url: "/assets/app-12345678.css",
      headers: { "accept-encoding": "gzip" },
    });
    expect(gunzipSync(css.rawPayload).toString()).toBe(
      "body { color: red; }\n".repeat(100)
    );
  });

  it("preserves no-cache behavior and current themed HTML on deep links", async () => {
    const { app, runtime } = await setup();
    for (const url of [
      "/",
      "/index.html",
      "/settings/general",
      "/manifest.webmanifest",
      "/sw.js",
    ]) {
      const response = await app.inject({
        url,
        headers: { "accept-encoding": "gzip" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe(
        "no-cache, no-store, must-revalidate"
      );
      expect(response.headers["content-encoding"]).toBe("gzip");
    }
    runtime.rewriteForColor("blue");
    const themed = await app.inject({
      url: "/settings/general",
      headers: { "accept-encoding": "gzip" },
    });
    expect(gunzipSync(themed.rawPayload).toString()).toBe(
      html.replaceAll("/icons/teal/", "/icons/blue/")
    );
  });

  it("does not compress API streams or turn missing API/assets into HTML", async () => {
    const { app } = await setup();
    const stream = await app.inject({
      url: "/api/v1/events",
      headers: { "accept-encoding": "br, gzip" },
    });
    expect(stream.headers["content-encoding"]).toBeUndefined();
    expect(stream.headers["content-type"]).toContain("text/event-stream");
    expect(stream.body).toBe(`data: ${"x".repeat(2048)}\n\n`);
    for (const url of ["/api/v1/missing", "/assets/missing.js"]) {
      expect((await app.inject(url)).statusCode).toBe(404);
    }
  });
});
