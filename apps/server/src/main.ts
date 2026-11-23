import { captureStartupAcpAdapter } from "./startup/acp-adapter.js";
import { restoreLegacyMacLaunchAgentEnvironment } from "./startup/shell-environment.js";

const loadTerminalWorker = () => import("./terminal/runner-worker.js");

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
} else if (process.argv[2] === "runner-terminal") {
  const { runTerminalWorker, runTypedTerminalWorker } =
    await loadTerminalWorker();
  const [, , , cwd, cols, rows] = process.argv;
  if (cols === undefined) await runTerminalWorker(cwd!);
  else await runTypedTerminalWorker(cwd!, Number(cols), Number(rows));
} else if (
  process.argv[2] === "runner-worker" ||
  [
    "runner-view-checkout",
    "runner-inspect-checkout",
    "runner-observe-checkout",
    "runner-watch-checkout",
  ].includes(process.argv[2]!)
) {
  // One worker entry for checkout operations as the workload account; the
  // older names stay for a runner started on an earlier build.
  const { runCheckoutWorker, WORKER_ALIASES } =
    await import("./agents/checkout-worker.js");
  const [mode, ...rest] = process.argv.slice(2);
  await runCheckoutWorker(
    mode === "runner-worker" ? rest : [WORKER_ALIASES[mode!]!, ...rest]
  );
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
} else if (process.argv[2] === "runner-checkout-command") {
  const { runCheckoutCommandCli } =
    await import("./agents/remote/checkout-command.js");
  await runCheckoutCommandCli(
    process.argv[3]!,
    process.argv[4]!,
    process.argv[5] || undefined,
    process.argv[6] || undefined
  );
} else if (process.argv[2] === "runner-engine-capability") {
  const { runEngineCapabilityWorker } =
    await import("./agents/remote/engine-capability-worker.js");
  await runEngineCapabilityWorker();
} else if (process.argv[2] === "runner-update-compatibility") {
  const { embeddedBuild } = await import("./agents/build-identity.js");
  const { runnerHandoff } = await import("./agents/remote/update-handoff.js");
  if (process.argv.length !== 3 || !embeddedBuild.revision)
    process.exitCode = 2;
  else
    process.stdout.write(
      JSON.stringify({ ...embeddedBuild, handoff: runnerHandoff }) + "\n"
    );
} else if (process.argv[2] === "runner-update-trial") {
  const { runRunnerUpdateTrial } =
    await import("./agents/remote/update-trial.js");
  await runRunnerUpdateTrial(process.argv.slice(3));
} else if (process.argv[2] === "runner-update-stage") {
  const { runRunnerUpdateStage } =
    await import("./agents/remote/update-stage-cli.js");
  await runRunnerUpdateStage(process.argv.slice(3));
} else if (process.argv[2] === "remote-runner") {
  const { streamHelper } = await import("./generated/runtime-assets.js");
  const { runRemoteRunner } = await import("./agents/remote/runner.js");
  const { createRemoteWorkspacePreparation, createSessionCore } =
    await import("@dispatch/runner/cli");
  await runRemoteRunner(process.argv[3]!, {
    streamHelper,
    createWorkspacePreparation: createRemoteWorkspacePreparation,
    createSessions: createSessionCore,
  });
} else if (process.argv[2] === "local-runner") {
  // This app's local runner child: same binary, same build.
  const { embeddedBuild } = await import("./agents/build-identity.js");
  const { runCli, createSessionCore } = await import("@dispatch/runner/cli");
  // The `posix-user` platform: checkout reads, preparation steps and GitHub
  // reads run in the child's process.
  // The agent host entry point too: the session core tracks the hosts it
  // names.
  const {
    checkoutWorkload,
    workspaceWorkload,
    githubWorkload,
    localHostEntry,
  } = await import("./agents/checkout-worker.js");
  const { localTerminalHandlers } = await loadTerminalWorker();
  await runCli(process.argv.slice(2), {
    build: {
      version: embeddedBuild.version,
      ...(embeddedBuild.revision && { revision: embeddedBuild.revision }),
    },
    platform: {
      workload: checkoutWorkload,
      workspace: workspaceWorkload,
      github: githubWorkload,
    },
    sessions: { entry: localHostEntry(), createSessions: createSessionCore },
    handlers: () => localTerminalHandlers(),
  });
} else if (process.argv[2] === "agent-host") {
  // The host is generic; Dispatch names the build it runs.
  const { runAgentHost } = await import("./agents/acp/host/main.js");
  const { embeddedBuild } = await import("./agents/build-identity.js");
  await runAgentHost(process.argv.slice(2), { build: embeddedBuild });
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
  captureStartupAcpAdapter();
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
