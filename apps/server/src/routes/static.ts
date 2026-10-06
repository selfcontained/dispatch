import path from "node:path";
import type { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import fastifyCompress from "@fastify/compress";

import type { FastifyInstance, onSendAsyncHookHandler } from "fastify";

type StaticRouteDeps = {
  getCachedIndexHtml: () => string;
  getCachedManifest: () => string;
  staticAssets: Map<string, { contentType: string; body: Buffer | string }>;
};

export async function registerStaticRoutes(
  app: FastifyInstance,
  deps: StaticRouteDeps
): Promise<void> {
  // These routes serve the production bundle embedded in release binaries,
  // not Vite's development server. Opt in per reply so API/SSE traffic keeps
  // its existing streaming behavior and request bodies aren't decompressed.
  await app.register(fastifyCompress, {
    global: false,
    globalDecompression: false,
    encodings: ["br", "gzip", "identity"],
  });
  const headMetadata: onSendAsyncHookHandler = async (
    request,
    reply,
    payload
  ) => {
    if (
      request.method === "HEAD" &&
      reply.hasHeader("Content-Encoding") &&
      payload !== null &&
      typeof (payload as Readable)?.pipe === "function"
    ) {
      // Bun otherwise advertises Content-Length: 0 when Fastify suppresses a
      // compressed stream for HEAD. Measure the same encoded representation
      // as GET before Fastify drops its body. GET remains streamed/asynchronous.
      const encoded = await buffer(payload as Readable);
      reply.header("Content-Length", encoded.length);
      return encoded;
    }
    return payload;
  };
  // Keep this scoped to static routes, before Fastify's generated HEAD
  // body-suppression hook.
  const staticOptions = { onSend: headMetadata };
  const noCacheHeaders = {
    "Cache-Control": "no-cache, no-store, must-revalidate",
  };

  app.get("/", staticOptions, async (_, reply) => {
    return reply
      .type("text/html")
      .header("Vary", "accept-encoding")
      .headers(noCacheHeaders)
      .compress(deps.getCachedIndexHtml());
  });

  app.get("/index.html", staticOptions, async (_, reply) => {
    return reply
      .type("text/html")
      .header("Vary", "accept-encoding")
      .headers(noCacheHeaders)
      .compress(deps.getCachedIndexHtml());
  });

  app.get("/manifest.webmanifest", staticOptions, async (_, reply) => {
    return reply
      .type("application/manifest+json")
      .header("Vary", "accept-encoding")
      .headers(noCacheHeaders)
      .compress(deps.getCachedManifest());
  });

  // A real fallback route participates in the compressor's route hooks.
  // Explicit API routes still take precedence over this wildcard.
  app.get("/*", staticOptions, async (request, reply) => {
    const url = request.url.split("?")[0];
    const staticAsset = deps.staticAssets.get(url);
    if (staticAsset) {
      const isServiceWorker = path.basename(url) === "sw.js";
      const response = reply
        .type(staticAsset.contentType)
        .header("Vary", "accept-encoding");
      if (isServiceWorker) {
        response.headers(noCacheHeaders);
      }
      return response.compress(staticAsset.body);
    }
    if (!url.startsWith("/api/") && !path.extname(url)) {
      return reply
        .type("text/html")
        .header("Vary", "accept-encoding")
        .headers(noCacheHeaders)
        .compress(deps.getCachedIndexHtml());
    }
    return reply.code(404).send({ error: "Not found" });
  });
}
