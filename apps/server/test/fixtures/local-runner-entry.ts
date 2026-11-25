/*
 * The app's real local runner child (`main.ts local-runner`) for process
 * tests and the app harness (`helpers/inject-app.ts`), with two crash points. Each kills the runner with SIGKILL once, the
 * first time its marker file exists, and removes the marker:
 *   RUNNER_DIE_AFTER_CREATE   right after Git made the worktree, before the
 *                             runner recorded it
 *   RUNNER_DIE_AFTER_INSTALL  after dependencies, before the binding
 */
import { existsSync, rmSync } from "node:fs";
import { createSessionCore, runCli } from "@dispatch/runner/cli";
import { embeddedBuild } from "../../src/agents/build-identity.js";
import {
  checkoutWorkload,
  localEnginePort,
  workspaceWorkload,
} from "../../src/agents/checkout-worker.js";
import { localTerminalHandlers } from "../../src/terminal/runner-worker.js";
import { localHostEntry } from "../../src/agents/acp/local-host-entry.js";

const dieOnce = (marker: string | undefined) => {
  if (marker && existsSync(marker)) {
    rmSync(marker);
    process.kill(process.pid, "SIGKILL");
  }
};

await runCli(process.argv.slice(2), {
  // The app's own build, as `main.ts local-runner` reports it.
  build: {
    version: embeddedBuild.version,
    ...(embeddedBuild.revision && { revision: embeddedBuild.revision }),
  },
  platform: {
    engines: localEnginePort(),
    workload: checkoutWorkload,
    workspace: {
      ...workspaceWorkload,
      async create(spec, path) {
        const made = await workspaceWorkload.create(spec, path);
        dieOnce(process.env.RUNNER_DIE_AFTER_CREATE);
        return made;
      },
      async installDependencies(directory, report) {
        await workspaceWorkload.installDependencies(directory, report);
        dieOnce(process.env.RUNNER_DIE_AFTER_INSTALL);
      },
    },
  },
  sessions: { entry: localHostEntry(), createSessions: createSessionCore },
  handlers: () => localTerminalHandlers(),
});
