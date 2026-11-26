import { captureStartupAcpAdapter } from "./startup/acp-adapter.js";
import { restoreLegacyMacLaunchAgentEnvironment } from "./startup/shell-environment.js";

const loadRunnerComposition = () => import("@dispatch/runner/composition");
const loadCheckoutWorker = () =>
  loadRunnerComposition().then((entry) => entry.loadCheckoutWorker());
async function loadLaunchProbes() {
  const { createLaunchFolderProbes } = await loadRunnerComposition().then(
    (entry) => entry.loadLocalWorkspaceProbes()
  );
  const { shouldSkipAutomaticMacPathProbe } =
    await import("./shared/mac-path-privacy.js");
  return createLaunchFolderProbes(shouldSkipAutomaticMacPathProbe);
}

// Modes of this binary, checked before anything else so none of them
// touches the server's environment restoration, database, or config:
//
// - `agent-host --state <dir>` runs one agent's ACP host.
// - `claude-acp` / `codex-acp` run the engine's ACP adapter over stdio.
//   The adapters ship inside this binary rather than as a global npm
//   install, so there is nothing for anyone to install or configure; each
//   one drives the engine CLI the user already has (see engine-spec.ts).
if (process.argv[2]?.startsWith("recovery-")) {
  try {
    const { runRecoveryCli } = await import("./update-recovery/cli.js");
    await runRecoveryCli(process.argv.slice(2));
  } catch {
    // Never print raw command, database or configuration errors with secrets.
    console.error(
      "Dispatch update recovery could not complete; installation remains fenced."
    );
    process.exitCode = 2;
  }
} else if (process.argv[2] === "init-local-tls") {
  if (
    process.env.DISPATCH_UPDATE_OWNER !== "macos-app" ||
    process.env.DISPATCH_LOCAL_TLS !== "1"
  ) {
    throw new Error(
      "Local TLS initialization requires the Mac app environment."
    );
  }
  const { ensureLocalTls } = await import("./local-tls.js");
  const { statePath } = await import("./state-dir.js");
  const { parseListenHosts } = await import("./multi-listener.js");
  ensureLocalTls(
    statePath("tls"),
    parseListenHosts(process.env.DISPATCH_LISTEN_HOSTS) ?? [
      process.env.DISPATCH_HOST ?? "127.0.0.1",
    ]
  );
} else if (!process.argv[2]) {
  await serve();
} else {
  const { dispatchRunnerMode } = await loadRunnerComposition();
  const assets = await import("./generated/runtime-assets.js");
  const { embeddedBuild } = await import("./agents/build-identity.js");
  const { shouldSkipAutomaticMacPathProbe } =
    await import("./shared/mac-path-privacy.js");
  if (
    !(await dispatchRunnerMode(
      process.argv.slice(2),
      { ...assets, build: embeddedBuild },
      shouldSkipAutomaticMacPathProbe
    ))
  )
    await serve();
}
async function serve(): Promise<void> {
  captureStartupAcpAdapter();
  const shellEnvironment = await restoreLegacyMacLaunchAgentEnvironment();

  const { loadInProcessPorts } = await import("./runners/in-process.js");
  await loadInProcessPorts(loadCheckoutWorker, await loadLaunchProbes());
  const { app, shutdown, start } = await import("./server.js");

  if (shellEnvironment.state === "resolved") {
    app.log.info({ shellEnvironment }, "Shell environment restored");
  }

  // Global error handlers — prevent silent crashes from background tasks
  process.on("unhandledRejection", (reason) => {
    app.log.error({ err: reason }, "Unhandled promise rejection");
  });

  process.on("uncaughtException", async (err) => {
    setTimeout(() => process.exit(1), 5_000).unref();
    app.log.error({ err }, "Uncaught exception — shutting down");
    await shutdown(1);
  });

  start()
    .then(async () => {
      try {
        const { cleanupLinuxAfterStartup } =
          await import("./update-recovery/linux.js");
        await cleanupLinuxAfterStartup();
      } catch {
        app.log.warn(
          "Completed update artifact cleanup deferred until the next startup."
        );
      }
    })
    .catch(async (error) => {
      app.log.error(error);
      await shutdown(1);
    });

  process.on("SIGINT", async () => {
    await shutdown(0);
  });

  process.on("SIGTERM", async () => {
    await shutdown(0);
  });
}
