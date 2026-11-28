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
import { githubWorkload } from "../../../../packages/runner/src/workload/agents/checkout-worker.js";
import { localTerminalHandlers } from "../../../../packages/runner/src/workload/terminal/runner-worker.js";
import { localHostEntry } from "../../../../packages/runner/src/host/local-host-entry.js";

import { createLaunchFolderProbes } from "../../../../packages/runner/src/workload/agents/local-workspace-probes.js";
import { shouldSkipAutomaticMacPathProbe } from "../../src/shared/mac-path-privacy.js";

// Only this test entry can shorten the real install command deadline. Keep the
// production installer, command runner, signal handling, and exit cleanup intact.
if (process.env.RUNNER_FIXTURE_INSTALL_TIMEOUT_MS) {
  const timeoutMs = Number(process.env.RUNNER_FIXTURE_INSTALL_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 1_000)
    throw new Error("Invalid fixture install timeout");
  const commands =
    await import("../../../../packages/runner/src/workload/shared/lib/run-command.js");
  const actual = commands.runCommand;
  const { mock } = await import("bun:test");
  mock.module(
    "../../../../packages/runner/src/workload/shared/lib/run-command.js",
    () => ({
      ...commands,
      runCommand: (...args: Parameters<typeof actual>) => {
        const [command, argv, options] = args;
        if (command === "npm" && argv.length === 1 && argv[0] === "install") {
          if (process.env.RUNNER_FIXTURE_INSTALL_TIMEOUT_LOG)
            appendFileSync(
              process.env.RUNNER_FIXTURE_INSTALL_TIMEOUT_LOG,
              JSON.stringify({
                command,
                originalTimeoutMs: options?.timeoutMs,
                timeoutMs,
              }) + "\n"
            );
          return actual(command, argv, { ...options, timeoutMs });
        }
        return actual(...args);
      },
    })
  );
}

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
      launchProbes: createLaunchFolderProbes(shouldSkipAutomaticMacPathProbe),
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
