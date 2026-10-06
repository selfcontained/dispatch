import type { FastifyInstance } from "fastify";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function httpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

/** Protect browser writes even when a preview has no password configured. */
export function registerBrowserOriginProtection(
  app: FastifyInstance,
  additionalOrigins = ""
): void {
  const allowedOrigins = new Set<string>();
  for (const value of additionalOrigins
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)) {
    const origin = httpOrigin(value);
    if (!origin || origin !== value) {
      throw new Error(
        "DISPATCH_ALLOWED_ORIGINS must contain comma-separated HTTP(S) origins without paths."
      );
    }
    allowedOrigins.add(origin);
  }

  app.addHook("onRequest", async (request, reply) => {
    // The router decodes paths before matching; raw URLs such as /%61pi/...
    // must receive the same protection as the canonical API route.
    const routeUrl = request.routeOptions.url;
    if (SAFE_METHODS.has(request.method) || !routeUrl?.startsWith("/api/"))
      return;

    // These extension endpoints never use cookie/first-run authorization:
    // scoped bearer routes authenticate themselves; pairing requires explicit
    // approval through the protected Dispatch UI before exchanging a secret.
    if (
      request.routeOptions.config.browserExtensionBearer ||
      request.routeOptions.config.browserExtensionPairing
    )
      return;

    const origin = request.headers.origin;
    const referer = request.headers.referer;
    const source = origin ?? referer;
    let allowed: boolean;
    if (source !== undefined) {
      const sourceOrigin = httpOrigin(source);
      const targetOrigin = httpOrigin(
        `${request.protocol}://${request.headers.host}`
      );
      // Origin must be a serialized origin, not a URL with a path or credentials.
      allowed =
        sourceOrigin !== null &&
        (origin === undefined || sourceOrigin === origin) &&
        (sourceOrigin === targetOrigin || allowedOrigins.has(sourceOrigin));
    } else {
      // CLI/MCP/webhook clients normally send neither header. Fetch Metadata
      // still lets us reject browser requests with suppressed origin headers.
      const site = request.headers["sec-fetch-site"];
      allowed = site === undefined || site === "same-origin" || site === "none";
    }
    if (!allowed) {
      return reply.code(403).send({
        error: "Browser origin is not allowed.",
        code: "UNTRUSTED_ORIGIN",
      });
    }
  });
}
