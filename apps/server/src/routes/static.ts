import path from "node:path";

import type { FastifyInstance } from "fastify";

type StaticRouteDeps = {
  cachedIndexHtml: string;
  cachedManifest: string;
  staticAssets: Map<string, { contentType: string; body: Buffer | string }>;
};

export async function registerStaticRoutes(
  app: FastifyInstance,
  deps: StaticRouteDeps
): Promise<void> {
  const noCacheHeaders = {
    "Cache-Control": "no-cache, no-store, must-revalidate",
  };

  app.get("/", async (_, reply) => {
    return reply
      .type("text/html")
      .headers(noCacheHeaders)
      .send(deps.cachedIndexHtml);
  });

  app.get("/index.html", async (_, reply) => {
    return reply
      .type("text/html")
      .headers(noCacheHeaders)
      .send(deps.cachedIndexHtml);
  });

  app.get("/manifest.webmanifest", async (_, reply) => {
    return reply
      .type("application/manifest+json")
      .headers(noCacheHeaders)
      .send(deps.cachedManifest);
  });

  app.setNotFoundHandler(async (request, reply) => {
    const url = request.url.split("?")[0];
    const staticAsset = deps.staticAssets.get(url);
    if (staticAsset) {
      const isServiceWorker = path.basename(url) === "sw.js";
      const response = reply.type(staticAsset.contentType);
      if (isServiceWorker) {
        response.headers(noCacheHeaders);
      }
      return response.send(staticAsset.body);
    }
    if (!url.startsWith("/api/") && !path.extname(url)) {
      return reply
        .type("text/html")
        .headers(noCacheHeaders)
        .send(deps.cachedIndexHtml);
    }
    return reply.code(404).send({ error: "Not found" });
  });
}
