/*
 * The agent host as the local runner child starts it: its entry point, its
 * launch file written from the launch request, and its ownership marker.
 * Kept apart from `host-command.ts`, which the host itself imports.
 */
import { childProcessEnv } from "../workload/shared/process/child-environment.js";
import {
  killOwnedProcesses,
  ownedEnvironment,
  ownedProcessPids,
} from "../workload/shared/process/owned-processes.js";
import {
  hostCommand,
  loginShellCommand,
} from "@dispatch/runner/host/host-command";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  displayPath,
  RunnerCallError,
  sessionToWire,
  type Req,
} from "@dispatch/runner-protocol/contract";
import {
  engineStatuses,
  engineVersion,
  missingEngineMessage,
} from "../workload/agents/engine-availability.js";
import {
  isAcpEngine,
  type AcpEngineId,
  type EngineBins,
} from "@dispatch/runner-protocol/host";
import {
  agentLaunchBindings,
  prepareHostLaunch,
  writeHostLaunch,
} from "@dispatch/runner/host/host-env";

/**
 * The agent host as the local runner child starts and identifies it (its
 * `posix-user` host entry): this binary's `agent-host` mode through the
 * user's login shell, with an ownership marker whose processes are cleaned
 * up after the host.
 */
export function localHostEntry(settings = configuredLaunchEnvironment()) {
  return {
    command: () => hostCommand(),
    wrap: (command: string[]) => loginShellCommand(command),
    env: () => childProcessEnv(),
    prepare: (dir: string, request: Req<"session.launch">) =>
      writeLocalHostLaunch(dir, request, settings),
    ownership: {
      create: (env: NodeJS.ProcessEnv) => ownedEnvironment(env),
      cleanup: (marker: string) => killOwnedProcesses(marker),
      members: (marker: string) => ownedProcessPids(marker),
    },
  };
}

/** The MCP server name a host uses when its launch names none. */
const DEFAULT_MCP_NAME = "dispatch";

/**
 * The launch's programs as the host's engine bins: a program sent as null
 * is null, one not sent is absent, exactly as the app wrote them.
 */
function programsToBins(
  programs: Req<"session.launch">["programs"]
): EngineBins {
  const all = programs ?? {};
  const path = (name: string) =>
    name in all ? (all[name] ? all[name].path : null) : undefined;
  const adapter = all.adapter;
  return {
    claudeBin: path("claude") as string,
    codexBin: path("codex") as string | null,
    opencodeBin: path("opencode"),
    ...(adapter && {
      adapter: {
        bin: adapter.path,
        ...(adapter.args !== undefined && { args: adapter.args }),
      },
    }),
  };
}

type LocalLaunchEnvironment = {
  filesRoot: string;
  helperBin: string;
  env: Record<string, string>;
  bins: EngineBins;
};

export function configuredLaunchEnvironment():
  | LocalLaunchEnvironment
  | undefined {
  const value = process.env.DISPATCH_LOCAL_RUNNER_LAUNCH;
  return value ? (JSON.parse(value) as LocalLaunchEnvironment) : undefined;
}

async function resolveLocalBins(
  engine: AcpEngineId,
  bins: EngineBins,
  agentId: string
): Promise<EngineBins> {
  const status = (
    await engineStatuses({
      claude: bins.claudeBin,
      codex: bins.codexBin ?? undefined,
      opencode: bins.opencodeBin ?? undefined,
    })
  ).find((status) => status.id === engine)!;
  if (!status.path)
    throw new RunnerCallError({
      code: "unsupported",
      message: missingEngineMessage(status),
      details: "engine_missing",
    });
  const version = await engineVersion(status.path);
  process.stderr.write(
    `local-runner: launching ${agentId} on ${status.path} (${version ?? "unknown version"})\n`
  );
  return { ...bins, [`${engine}Bin`]: status.path };
}

/** Write the host's launch file from the runner's own launch environment. */
export async function writeLocalHostLaunch(
  dir: string,
  request: Req<"session.launch">,
  local = configuredLaunchEnvironment()
) {
  const agentId = sessionToWire(request.session);
  const [mcp] = request.mcp;
  if (!request.directory) throw new Error("A local launch names its directory");
  const engine = request.engine;
  if (!isAcpEngine(engine))
    throw new RunnerCallError({
      code: "unsupported",
      message: `Unsupported engine ${engine}`,
    });
  const filesDir = local
    ? path.join(local.filesRoot, agentId)
    : path.join(dir, "files");
  const launch = await prepareHostLaunch(
    dir,
    {
      agentId,
      cwd: displayPath(request.directory),
      engine,
      bins:
        request.programs || !local
          ? programsToBins(request.programs)
          : await resolveLocalBins(engine, local.bins, agentId),
      model: request.model,
      effort: request.effort,
      fullAccess: request.access === "full",
      systemPrompt: request.systemText,
      personaContext: request.firstText,
      mcp: mcp && {
        url: mcp.url,
        token: mcp.token,
        ...(mcp.name !== DEFAULT_MCP_NAME && { name: mcp.name }),
      },
      resumeSessionId: request.resume,
    },
    {
      filesDir,
      helperBin: local?.helperBin ?? "",
      home: local && process.env.HOME,
      mcpOrigin: mcp && new URL(mcp.url).origin,
      mcpCaFile: local?.env.DISPATCH_LOCAL_CA_CERTIFICATE,
      env: {
        ...(local && agentLaunchBindings(engine)),
        ...local?.env,
        ...request.env,
      },
    }
  );
  if (request.pathPrefix)
    launch.pathPrefix = request.pathPrefix.map(displayPath);
  if (local) await mkdir(launch.env.DISPATCH_FILES_DIR!, { recursive: true });
  await writeHostLaunch(dir, launch, "w");
}
