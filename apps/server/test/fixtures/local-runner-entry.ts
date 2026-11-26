/*
 * The app's real local runner child (`main.ts local-runner`) for process
 * tests and the app harness (`helpers/inject-app.ts`), with two crash points. Each kills the runner with SIGKILL once, the
 * first time its marker file exists, and removes the marker:
 *   RUNNER_DIE_AFTER_CREATE   right after Git made the worktree, before the
 *                             runner recorded it
 *   RUNNER_DIE_AFTER_INSTALL  after dependencies, before the binding
 *   RUNNER_DIE_BEFORE_RELEASE before removing a released worktree
 *   RUNNER_DIE_AFTER_RELEASE  after removing it, before the reply
 */
import { appendFileSync, existsSync, rmSync } from "node:fs";
import { createSessionCore, runCli } from "@dispatch/runner/cli";
import { embeddedBuild } from "../../src/agents/build-identity.js";
import {
  checkoutWorkload,
  localEnginePort,
  workspaceWorkload,
} from "../helpers/checkout-workload.js";
import { githubWorkload } from "../../src/agents/checkout-worker.js";
import { localTerminalHandlers } from "../../src/terminal/runner-worker.js";
import { localHostEntry } from "../../src/agents/acp/local-host-entry.js";

const dieOnce = (marker: string | undefined) => {
  if (marker && existsSync(marker)) {
    rmSync(marker);
    process.kill(process.pid, "SIGKILL");
  }
};

if (process.env.RUNNER_FIXTURE_CWD)
  process.chdir(process.env.RUNNER_FIXTURE_CWD);

// Fixture-only pause after the real child accepts a native read, for loss/recovery pins.
if (process.env.RUNNER_FIXTURE_NATIVE_PAUSE) {
  const run = checkoutWorkload.run;
  checkoutWorkload.run = async (op, input, options) => {
    if (
      op === "checkout.access" ||
      ((op === "checkout.list" || op === "checkout.read") &&
        (input.request as { mode?: string }).mode === "native")
    ) {
      appendFileSync(process.env.RUNNER_FIXTURE_NATIVE_PAUSE!, op + "\n");
      await new Promise<never>(() => {});
    }
    return run(op, input, options);
  };
}

const engines = localEnginePort();
// Fixture-only provider acts: no provider or ambient credentials are ever read.
if (process.env.RUNNER_FIXTURE_RESET_LOG) {
  engines.usage = async () => ({
    checkedAt: new Date().toISOString(),
    providers: [],
  });
  engines.quotaReset = async (request) => {
    appendFileSync(
      process.env.RUNNER_FIXTURE_RESET_LOG!,
      request.requestId + "\n"
    );
    dieOnce(process.env.RUNNER_DIE_AFTER_RESET);
    return { code: "ok", windowsReset: 1, credit: null };
  };
}
const updateSpawn = engines.updateSpawn.bind(engines);
engines.updateSpawn = async (request) => {
  const result = await updateSpawn(request);
  dieOnce(process.env.RUNNER_DIE_AFTER_ENGINE_SPAWN);
  return result;
};

await runCli(process.argv.slice(2), {
  // The app's own build, as `main.ts local-runner` reports it.
  build: {
    version: embeddedBuild.version,
    ...(embeddedBuild.revision && { revision: embeddedBuild.revision }),
  },
  platform: {
    github: githubWorkload,
    engines,
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
      async release(session, checkout, request) {
        dieOnce(process.env.RUNNER_DIE_BEFORE_RELEASE);
        const removed = await workspaceWorkload.release(
          session,
          checkout,
          request
        );
        dieOnce(process.env.RUNNER_DIE_AFTER_RELEASE);
        return removed;
      },
    },
  },
  sessions: { entry: localHostEntry(), createSessions: createSessionCore },
  handlers: () => localTerminalHandlers(),
});
