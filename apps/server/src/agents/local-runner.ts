import { execFile } from "node:child_process";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { FastifyBaseLogger } from "fastify";
import {
  displayPath,
  sessionToWire,
  type Req,
} from "@dispatch/runner-protocol/contract";
import { childProcessEnv } from "../shared/process/child-environment.js";
import { hostFile, type HostLaunch } from "./acp/host-protocol.js";
import { preparePersonaContext } from "./acp/persona-context.js";

import {
  createWorkspacePreparation,
  resolveLaunchDirectory,
} from "./workspace.js";
import { resolveProjectRoot } from "../projects/resolve-root.js";
import { localCheckoutRelease } from "./local-runner-checkout.js";
import { inferRepositoryUrl } from "./remote/repository.js";

const processArgs = promisify(execFile);

async function readHostPid(dir: string): Promise<number | null> {
  const record = await readFile(hostFile(dir, "pid"), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  );
  return record === null ? null : Number(record.trim());
}

async function inspectHostProcess(dir: string): Promise<{
  processState: "live" | "gone" | "stale";
  pid: number | null;
}> {
  const pid = await readHostPid(dir);
  if (pid === null) return { processState: "gone", pid: null };
  if (!Number.isSafeInteger(pid) || pid <= 0)
    return { processState: "stale", pid: null };
  if (!pidAlive(pid)) return { processState: "gone", pid: null };
  if (await hostPidMatches(pid, dir)) return { processState: "live", pid };
  return { processState: "stale", pid: null };
}

async function hostPidMatches(pid: number, dir: string): Promise<boolean> {
  if (!pidAlive(pid)) return false;
  try {
    const { stdout } = await processArgs(
      "/bin/ps",
      ["-p", String(pid), "-o", "args="],
      { env: childProcessEnv(), timeout: 2_000 }
    );
    return stdout.trim().endsWith(`agent-host --state ${dir}`);
  } catch {
    return false;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** In-process implementation of runner lifecycle operations for native agent hosts.
 * The native workload and the host service share an OS account. State
 * paths and host sockets must stay compatible with hosts from earlier versions.
 */
export function createLocalRunner(
  agentStateRoot: string,
  logger: FastifyBaseLogger
) {
  function stateDir(agentId: string) {
    if (
      !agentId ||
      agentId === "." ||
      agentId === ".." ||
      path.basename(agentId) !== agentId
    )
      throw new Error("Invalid agent state directory");
    return path.join(agentStateRoot, agentId);
  }
  async function deliverSessionFile(
    agentId: string,
    source: string,
    purpose: "prompt" | "reference" = "prompt"
  ) {
    stateDir(agentId);
    // Already visible to the workload. A missing file drops out of the prompt.
    // Listings historically include registry rows even if the file vanished.
    if (purpose === "prompt") await stat(source);
    return source;
  }

  async function collectSessionFile(agentId: string, source: string) {
    stateDir(agentId);
    return readFile(source);
  }

  const workspace = createWorkspacePreparation();
  return {
    deliverSessionFile,
    collectSessionFile,
    checkoutRelease: localCheckoutRelease,
    resolveLaunchDirectory,
    canonicalPath: (directory: string) => realpath(directory).catch(() => null),
    resolveProjectRoot,
    inferRepositoryUrl,
    /**
     * Record a launch's worktree request before its row exists, in the
     * receipt the local runner prepares from. Without a request, bring a
     * receipt an earlier build of this branch wrote into the runner's shape
     * before the runner resumes it.
     */
    bindWorkspace: (
      agentId: string,
      ...intent:
        | [
            directory: Parameters<typeof workspace.bind>[1],
            request: Parameters<typeof workspace.bind>[2],
          ]
        | []
    ) =>
      intent.length
        ? workspace.bind(stateDir(agentId), ...intent)
        : workspace.upgrade(stateDir(agentId)),
    requestedWorktree: (agentId: string) =>
      workspace.requested(stateDir(agentId)),
    /** The live host's pid, for resource sampling only: never signalled. */
    async hostPid(agentId: string) {
      return (await inspectHostProcess(stateDir(agentId))).pid;
    },
  };
}

/** The MCP server name a host uses when its launch names none. */
const DEFAULT_MCP_NAME = "dispatch";

/**
 * The launch's programs as the host's engine bins: a program sent as null
 * is null, one not sent is absent, exactly as the app wrote them.
 */
export function programsToBins(
  programs: Req<"session.launch">["programs"]
): HostLaunch["bins"] {
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

/**
 * Write the host's launch file (and persona context) for `request` into
 * `dir`, byte for byte as the app wrote it before the runner started hosts.
 */
export async function writeLocalHostLaunch(
  dir: string,
  request: Req<"session.launch">
) {
  const agentId = sessionToWire(request.session);
  const [mcp] = request.mcp;
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.env)) {
    if (typeof value === "string") env[name] = value;
    else if (value.from === "session.id") env[name] = agentId;
    else throw new Error(`Unsupported launch environment value ${value.from}`);
  }
  if (!request.directory) throw new Error("A local launch names its directory");
  const launch: HostLaunch = {
    agentId,
    cwd: displayPath(request.directory),
    engine: request.engine as HostLaunch["engine"],
    bins: programsToBins(request.programs),
    model: request.model,
    effort: request.effort,
    fullAccess: request.access === "full",
    systemPrompt: request.systemText,
    personaContext: await preparePersonaContext(dir, request.firstText),
    mcp: mcp && {
      url: mcp.url,
      token: mcp.token,
      ...(mcp.name !== DEFAULT_MCP_NAME && { name: mcp.name }),
    },
    env,
    pathPrefix: (request.pathPrefix ?? []).map(displayPath),
    resumeSessionId: request.resume,
  };
  await writeFile(hostFile(dir, "launch"), JSON.stringify(launch, null, 2), {
    mode: 0o600,
  });
}
