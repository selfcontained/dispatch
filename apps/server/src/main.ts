import { restoreLegacyMacLaunchAgentEnvironment } from "./startup/shell-environment.js";

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
} else if (process.argv[2] === "remote-runner-pair") {
  const { runRunnerPairing } = await import("./agents/remote/enrollment.js");
  await runRunnerPairing(process.argv.slice(3));
} else if (process.argv[2] === "connect") {
  const { runRunnerConnect } = await import("./agents/remote/enrollment.js");
  await runRunnerConnect(process.argv.slice(3));
} else if (process.argv[2] === "runner-watch-checkout") {
  const { runCheckoutWatchCli } = await import("./agents/checkout-watch.js");
  runCheckoutWatchCli(process.argv[3]!);
} else if (process.argv[2] === "runner-prepare-dependencies") {
  const { installWorkspaceDependencies } =
    await import("./agents/workspace-prep.js");
  const installed = await installWorkspaceDependencies(process.argv[3]!, {
    info() {},
    warn() {},
  });
  if (!installed) process.exitCode = 1;
} else if (process.argv[2] === "runner-session-file") {
  const { runSessionFileCli } =
    await import("./agents/remote/session-files.js");
  await runSessionFileCli(process.argv[3]!, process.argv[4]!, process.argv[5]!);
} else if (process.argv[2] === "runner-view-checkout") {
  const { runCheckoutViewCli } = await import("./agents/checkout-view-cli.js");
  await runCheckoutViewCli(process.argv[3]!, process.argv[4] === "--managed");
} else if (process.argv[2] === "runner-observe-checkout") {
  const { observeGitCheckout, observeScratchCheckout } =
    await import("./agents/checkout-inspection.js");
  try {
    const observe =
      process.argv[4] === "--scratch"
        ? observeScratchCheckout
        : observeGitCheckout;
    process.stdout.write(JSON.stringify(await observe(process.argv[3]!)));
  } catch {
    process.exitCode = 1;
  }
} else if (process.argv[2] === "runner-inspect-checkout") {
  const { runCheckoutInspectionCli } =
    await import("./agents/checkout-inspection.js");
  await runCheckoutInspectionCli(process.argv[3]!);
} else if (process.argv[2] === "remote-runner") {
  const { runRemoteRunner } = await import("./agents/remote/runner.js");
  await runRemoteRunner(process.argv[3]!);
} else if (process.argv[2] === "agent-host") {
  await import("./agents/acp/host/main.js");
} else if (process.argv[2] === "claude-acp") {
  // The dependency patch exports upstream's CLI so the bundled adapter
  // uses its managed policy, logging, and stdio shutdown behavior.
  await import("@agentclientprotocol/claude-agent-acp/dispatch-cli");
} else if (process.argv[2] === "codex-acp") {
  await import("@agentclientprotocol/codex-acp/dist/index.js");
} else {
  await serve();
}

async function serve(): Promise<void> {
  const shellEnvironment = await restoreLegacyMacLaunchAgentEnvironment();

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
