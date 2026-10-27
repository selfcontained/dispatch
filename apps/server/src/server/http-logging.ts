import { existsSync } from "node:fs";
import { constants } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { errorCodes } from "fastify";
import type {
  FastifyInstance,
  FastifyRequest,
  FastifyServerOptions,
} from "fastify";

const safeErrorNames = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "URIError",
  "EvalError",
]);
const safeErrorCodes = new Set([
  ...Object.keys(errorCodes),
  ...Object.keys(constants.errno),
]);
const sourceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

/** Omit free-form messages, arbitrary error names/codes, and non-source frames. */
function errorDetails(error: Error & { code?: string }) {
  let source: string | undefined;
  // A message may itself contain newlines that resemble stack frames. Only
  // accept an existing file inside this server's source tree, never raw text.
  for (const frame of error.stack?.split("\n").slice(1) ?? []) {
    if (!/^\s+at /.test(frame)) continue;
    // Compiled Bun stacks use virtual paths; retain only numeric location,
    // never the virtual filename (which is not a source path on disk).
    const bundled = frame.match(
      /(?:\(|\s)\/\$bunfs\/root\/[^():\s]+:(\d+):(\d+)\)?$/
    );
    if (bundled) {
      source = `bundled-server:${bundled[1]}:${bundled[2]}`;
      break;
    }
    const match = frame.match(/(?:\(|\s)([^()]+\.(?:ts|js)):(\d+):(\d+)\)?$/);
    if (!match) continue;
    const relative = path.relative(sourceRoot, match[1]!);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    if (
      !/^[a-zA-Z0-9_./-]+$/.test(relative) ||
      !existsSync(path.join(sourceRoot, relative))
    )
      continue;
    source = `${relative}:${match[2]}:${match[3]}`;
    break;
  }
  return {
    errorType: safeErrorNames.has(error.name) ? error.name : "Error",
    errorCode:
      error.code && safeErrorCodes.has(error.code) ? error.code : undefined,
    source,
  };
}

/** Disable Fastify's info pairs (and their raw URL serializer) in every mode. */
export function httpLoggingOptions(
  env: NodeJS.ProcessEnv = process.env
): FastifyServerOptions {
  return {
    disableRequestLogging: true,
    logger: {
      level: env.DISPATCH_HTTP_DEBUG === "1" ? "debug" : "info",
      // Also protect explicit structured { req } logs from raw URLs/headers.
      serializers: {
        req: (request) => ({
          method: request.method,
          route: request.routeOptions?.url,
        }),
      },
    },
  };
}

/**
 * Only route templates are logged: params, queries, headers, bodies and thrown
 * error text can contain credentials. Existing application error logs remain.
 */
export function registerHttpLogging(app: FastifyInstance): void {
  const loggedErrors = new WeakSet<object>();
  const fields = (request: FastifyRequest) => ({
    method: request.method,
    route: request.routeOptions.url,
  });

  app.addHook("onRequest", async (request) => {
    request.log.debug(fields(request), "HTTP request received");
  });
  app.addHook("onError", async (request, reply, error) => {
    loggedErrors.add(request);
    // Fastify sets error.statusCode on the reply after onError runs.
    const statusCode =
      reply.statusCode >= 400 ? reply.statusCode : (error.statusCode ?? 500);
    request.log[statusCode >= 500 ? "error" : "warn"](
      { ...fields(request), statusCode, ...errorDetails(error) },
      "HTTP request failed"
    );
  });
  app.addHook("onResponse", async (request, reply) => {
    if (loggedErrors.has(request)) return;
    const statusCode = reply.statusCode;
    const level =
      statusCode >= 500 ? "error" : statusCode >= 400 ? "warn" : "debug";
    request.log[level](
      { ...fields(request), statusCode, responseTime: reply.elapsedTime },
      statusCode >= 400 ? "HTTP request failed" : "HTTP request completed"
    );
  });
  app.addHook("onTimeout", async (request) => {
    request.log.warn(fields(request), "HTTP request timed out");
  });
  app.addHook("onRequestAbort", async (request) => {
    request.log.warn(fields(request), "HTTP request aborted");
  });
}
