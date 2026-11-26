import * as workers from "./composition.js";
import type { BuildIdentity } from "@dispatch/runner-protocol/build-identity";
import type { PathProbePolicy } from "./workload/agents/local-workspace-probes.js";

export type RunnerAssets = {
  build: BuildIdentity;
  packageVersion: string;
  gitSha: string | null;
  streamHelper: string;
};
export async function dispatchRunnerMode(
  argv: string[],
  assets: RunnerAssets,
  skipPathProbe: PathProbePolicy
): Promise<boolean> {
  if (argv[0] === "remote-runner-pair") {
    const { runRunnerPairing } = await workers.loadEnrollment();
    await runRunnerPairing(argv.slice(1));
  } else if (argv[0] === "connect") {
    const { runRunnerConnect } = await workers.loadEnrollment();
    await runRunnerConnect(argv.slice(1));
  } else if (argv[0] === "runner-terminal") {
    const { runTerminalWorker, runTypedTerminalWorker } =
      await workers.loadRunnerWorker();
    const [, cwd, cols, rows] = argv;
    if (cols === undefined) await runTerminalWorker(cwd!);
    else await runTypedTerminalWorker(cwd!, Number(cols), Number(rows));
  } else if (
    argv[0] === "runner-worker" ||
    [
      "runner-view-checkout",
      "runner-inspect-checkout",
      "runner-observe-checkout",
      "runner-watch-checkout",
    ].includes(argv[0]!)
  ) {
    // One worker entry for checkout operations as the workload account; the
    // older names stay for a runner started on an earlier build.
    const { runCheckoutWorker, WORKER_ALIASES } =
      await workers.loadCheckoutWorker();

    const [mode, ...rest] = argv;
    await runCheckoutWorker(
      mode === "runner-worker" ? rest : [WORKER_ALIASES[mode!]!, ...rest],
      {
        launchProbes: (
          await workers.loadLocalWorkspaceProbes()
        ).createLaunchFolderProbes(skipPathProbe),
      }
    );
  } else if (argv[0] === "runner-prepare-dependencies") {
    const { installWorkspaceDependencies } = await workers.loadWorkspacePrep();
    const installed = await installWorkspaceDependencies(argv[1]!, {
      info() {},
      warn() {},
    });
    if (!installed) process.exitCode = 1;
  } else if (argv[0] === "runner-session-file") {
    const { runSessionFileCli } = await workers.loadSessionFiles();
    await runSessionFileCli(argv[1]!, argv[2]!, argv[3]!);
  } else if (argv[0] === "runner-checkout-command") {
    const { runCheckoutCommandCli } = await workers.loadCheckoutCommand();
    await runCheckoutCommandCli(
      argv[1]!,
      argv[2]!,
      argv[3] || undefined,
      argv[4] || undefined
    );
  } else if (
    argv[0] === "runner-engine-capability" ||
    argv[0] === "runner-engine-host"
  ) {
    const { runEngineCapabilityWorker, runEngineHostWorker } =
      await workers.loadEngineCapabilityWorker();
    if (argv[0] === "runner-engine-host") await runEngineHostWorker();
    else await runEngineCapabilityWorker();
  } else if (argv[0] === "runner-update-compatibility") {
    const embeddedBuild = assets.build;
    const { runnerHandoff } = await workers.loadUpdateHandoff();
    if (argv.length !== 1 || !embeddedBuild.revision) process.exitCode = 2;
    else
      process.stdout.write(
        JSON.stringify({ ...embeddedBuild, handoff: runnerHandoff }) + "\n"
      );
  } else if (argv[0] === "runner-update-trial") {
    const { runRunnerUpdateTrial } = await workers.loadUpdateTrial();
    const embeddedBuild = assets.build;
    await runRunnerUpdateTrial(argv.slice(1), { build: embeddedBuild });
  } else if (argv[0] === "runner-update-stage") {
    const { runRunnerUpdateStage } = await workers.loadUpdateStageCli();
    const { packageVersion } = assets;
    await runRunnerUpdateStage(argv.slice(1), { packageVersion });
  } else if (argv[0] === "remote-runner") {
    const { streamHelper, packageVersion, gitSha } = assets;
    const embeddedBuild = assets.build;
    const { runRemoteRunner } = await workers.loadRunner();
    const { createRemoteWorkspacePreparation, createSessionCore } =
      await import("./cli.js");
    await runRemoteRunner(argv[1]!, {
      build: embeddedBuild,
      healthBuild: { version: packageVersion, revision: gitSha },
      streamHelper,
      createWorkspacePreparation: createRemoteWorkspacePreparation,
      createSessions: createSessionCore,
    });
  } else if (argv[0] === "local-runner") {
    // This app's local runner child: same binary, same build.
    const embeddedBuild = assets.build;
    const { runCli, createSessionCore } = await import("./cli.js");
    // The `posix-user` platform: checkout reads, preparation steps, GitHub
    // reads and engine sign-in run in the child's process.
    // The agent host entry point too: the session core tracks the hosts it
    // names.
    const {
      createCheckoutWorkload,
      workspaceWorkload,
      githubWorkload,
      localEnginePort,
      localHostEntry,
    } = await workers.loadCheckoutWorker();

    const { localTerminalHandlers } = await workers.loadRunnerWorker();
    await runCli(argv, {
      build: {
        version: embeddedBuild.version,
        ...(embeddedBuild.revision && { revision: embeddedBuild.revision }),
      },
      platform: {
        workload: createCheckoutWorkload(),
        workspace: {
          ...workspaceWorkload,
          launchProbes: (
            await workers.loadLocalWorkspaceProbes()
          ).createLaunchFolderProbes(skipPathProbe),
        },
        github: githubWorkload,
        engines: localEnginePort(),
      },
      sessions: { entry: localHostEntry(), createSessions: createSessionCore },
      handlers: () => localTerminalHandlers(),
    });
  } else if (argv[0] === "agent-host") {
    // The host is generic; Dispatch names the build it runs and its search path.
    const { runAgentHost } = await import("./cli.js");
    const embeddedBuild = assets.build;
    const { hostSearchPath } = await workers.loadHostSearchPath();
    const { engineVersion } = await workers.loadEngineAvailability();
    await runAgentHost(argv, {
      engineVersion,
      build: embeddedBuild,
      searchPath: hostSearchPath,
    });
  } else if (argv[0] === "claude-acp") {
    // The dependency patch exports upstream's CLI so the bundled adapter
    // uses its managed policy, logging, and stdio shutdown behavior.
    await import("@agentclientprotocol/claude-agent-acp/dispatch-cli");
  } else if (argv[0] === "codex-acp") {
    await import("@agentclientprotocol/codex-acp/dist/index.js");
  } else return false;
  return true;
}
