import type { FastifyInstance } from "fastify";
import type { Runners } from "@dispatch/runner-protocol/contract";
import { placementForRunner } from "../runners/placement.js";

declare module "fastify" {
  interface FastifyContextConfig {
    /** Validate supplied authorization credentials even during passwordless setup. */
    validateSuppliedAuthorization?: boolean;
  }
}

export function registerRunnerGitHub(
  app: FastifyInstance,
  runners: Pick<Runners, "for">,
  onIdentityChange?: (runnerId: string) => void
) {
  const identities = new Map<string, string | null>();
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
        const id = req.params.id;
        const runner = runners.for(placementForRunner(id));
        const result = await (
          operation === "status"
            ? runner.call("github.account", {})
            : operation === "logout"
              ? runner.call("github.logout", {})
              : runner.call(
                  operation === "login"
                    ? "github.login.start"
                    : "github.login.cancel",
                  { requestId: crypto.randomUUID() }
                )
        ).catch(() => ({
          status: "unavailable" as const,
          message: "The runner could not report its GitHub account.",
        }));
        if (result.status === "signed-in" || result.status === "signed-out") {
          const login = result.status === "signed-in" ? result.login : null;
          if (identities.get(id) !== login) {
            identities.set(id, login);
            onIdentityChange?.(id);
          }
        }
        return result;
      },
    });
  }
}
