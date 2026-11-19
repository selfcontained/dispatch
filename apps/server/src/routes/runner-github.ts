import type { FastifyInstance } from "fastify";
import type { RemoteRunnerService } from "../agents/remote/service.js";

declare module "fastify" {
  interface FastifyContextConfig {
    /** Validate supplied authorization credentials even during passwordless setup. */
    validateSuppliedAuthorization?: boolean;
  }
}

export function registerRunnerGitHub(
  app: FastifyInstance,
  runners: Pick<RemoteRunnerService, "githubAccount">
) {
  const base = "/api/v1/runners/:id/github";
  const operations = [
    ["GET", base, "status"],
    ["POST", `${base}/login`, "login"],
    ["DELETE", `${base}/login`, "cancel"],
    ["DELETE", base, "logout"],
  ] as const;
  for (const [method, url, operation] of operations) {
    app.route<{ Params: { id: string } }>({
      method,
      url,
      config: { validateSuppliedAuthorization: true },
      async handler(req, reply) {
        reply.header("Cache-Control", "no-store");
        return runners.githubAccount(req.params.id, operation);
      },
    });
  }
}
