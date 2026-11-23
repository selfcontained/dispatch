import type { FastifyInstance } from "fastify";

import { EngineLogins } from "../src/agents/engine-login.js";
import { engineStatuses } from "../src/agents/engine-availability.js";
import { registerEngineLoginRoutes } from "../src/routes/engine-login.js";

/** main's wiring of the engine sign-in routes, on fixture CLIs. */
export async function buildEngineLoginApp(
  app: FastifyInstance,
  opts: {
    bins: { claude: string; codex: string; opencode: string };
    env: NodeJS.ProcessEnv;
    linkTimeoutMs?: number;
  }
): Promise<void> {
  const logins = new EngineLogins({
    resolveBin: async (engine) =>
      (await engineStatuses(opts.bins, opts.env)).find(
        (status) => status.id === engine
      )?.path ?? null,
    // Straight to the fixture CLI: no login shell, so no real HOME.
    command: (bin, args) => ({ bin, args }),
    env: opts.env,
    ...(opts.linkTimeoutMs ? { linkTimeoutMs: opts.linkTimeoutMs } : {}),
  });
  await registerEngineLoginRoutes(app, logins);
}
