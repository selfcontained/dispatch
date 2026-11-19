import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import type { FastifyBaseLogger } from "fastify";
import type { SessionLifecycleOperation } from "@dispatch/runner-protocol";
import {
  killOwnedProcesses,
  ownedEnvironment,
} from "../shared/process/owned-processes.js";
import {
  hostCommand,
  hostProcessEnv,
  loginShellCommand,
} from "./acp/host-command.js";
import { preparePersonaContext } from "./acp/persona-context.js";
import { hostFile, type HostLaunch } from "./acp/host-protocol.js";

import {
  createWorkspacePreparation,
  resolveLaunchDirectory,
} from "./workspace.js";
import { resolveWorkspace } from "./workspace-target.js";
import { resolveProjectRoot } from "../projects/resolve-root.js";
import { localCheckoutRelease } from "./local-runner-checkout.js";
import { inferRepositoryUrl } from "./remote/repository.js";

export type LocalLaunchSettings = Pick<
  HostLaunch,
  "cwd" | "env" | "bins" | "pathPrefix"
>;
export type SessionResult = {
  value?: string | boolean;
  channel?: Duplex;
  launchExited?: () => boolean;
};

const STOP_GRACE_MS = 8_000;
const KILL_GRACE_MS = 2_000;
const LOG_TAIL_LINES = 20;
const CONNECT_TIMEOUT_MS = 5_000;

async function readPid(stateDir: string): Promise<number | null> {
  try {
    const text = await readFile(hostFile(stateDir, "pid"), "utf8");
    const pid = Number(text.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
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

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
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
  const workspace = createWorkspacePreparation(logger);
  async function launch(input: HostLaunch) {
    const dir = stateDir(input.agentId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const launch: HostLaunch = {
      agentId: input.agentId,
      cwd: input.cwd,
      engine: input.engine,
      bins: input.bins,
      model: input.model,
      effort: input.effort ?? null,
      fullAccess: input.fullAccess ?? true,
      systemPrompt: input.systemPrompt,
      personaContext: await preparePersonaContext(dir, input.personaContext),
      mcp: input.mcp,
      env: input.env,
      pathPrefix: input.pathPrefix,
      resumeSessionId: input.resumeSessionId,
    };
    await writeFile(hostFile(dir, "launch"), JSON.stringify(launch, null, 2), {
      mode: 0o600,
    });
    // A stale socket from a dead host would make connect() spin on
    // ECONNREFUSED until the new host replaces it; clear it first.
    await unlink(hostFile(dir, "socket")).catch(() => {});

    const { bin, args } = loginShellCommand([...hostCommand(), "--state", dir]);
    const owned = ownedEnvironment(hostProcessEnv(process.env));
    await writeFile(path.join(dir, "ownership"), owned.marker, {
      mode: 0o600,
    });
    const logFd = openSync(hostFile(dir, "log"), "a");
    let child;
    try {
      child = spawn(bin, args, {
        cwd: input.cwd,
        env: owned.env,
        detached: true,
        stdio: ["ignore", logFd, logFd],
      });
    } finally {
      closeSync(logFd);
    }
    // The shell execs the host, so this is the host's own exit; a host
    // that dies during startup fails the launch at once instead of after
    // the whole connect timeout.
    let exited = false;
    child.on("exit", () => {
      exited = true;
      try {
        killOwnedProcesses(owned.marker);
      } catch (err) {
        logger.warn(
          { err, agentId: input.agentId },
          "host descendant cleanup failed"
        );
      }
    });
    child.on("error", (err) => {
      exited = true;
      logger.error({ err, agentId: input.agentId }, "agent host spawn failed");
    });
    child.unref();
    logger.info(
      { agentId: input.agentId, pid: child.pid, bin, args: args.slice(0, 3) },
      "agent host spawned"
    );
    return { launchExited: () => exited };
  }
  async function stop(agentId: string, force: boolean) {
    const dir = stateDir(agentId);
    const pid = await readPid(dir);
    if (pid && pidAlive(pid)) {
      const deadline = Date.now() + (force ? 0 : STOP_GRACE_MS);
      while (Date.now() < deadline && pidAlive(pid)) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (pidAlive(pid)) {
        signalGroup(pid, "SIGTERM");
        const killAt = Date.now() + KILL_GRACE_MS;
        while (Date.now() < killAt && pidAlive(pid)) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        if (pidAlive(pid)) signalGroup(pid, "SIGKILL");
      }
    }
    const marker = await readFile(path.join(dir, "ownership"), "utf8").catch(
      () => null
    );
    if (marker) {
      killOwnedProcesses(marker);
      await unlink(path.join(dir, "ownership")).catch(() => {});
    }
    await unlink(hostFile(dir, "socket")).catch(() => {});
    await unlink(hostFile(dir, "pid")).catch(() => {});
  }
  async function readLogTail(agentId: string) {
    try {
      const log = await readFile(hostFile(stateDir(agentId), "log"), "utf8");
      const tail = log.trim().split("\n").slice(-LOG_TAIL_LINES).join("\n");
      return tail
        ? `\n\nHost log (last ${LOG_TAIL_LINES} lines):\n${tail}`
        : "";
    } catch {
      return "";
    }
  }

  async function requestSession(
    operation: SessionLifecycleOperation,
    settings?: LocalLaunchSettings
  ): Promise<SessionResult> {
    const { agentId } = operation;
    const dir = stateDir(agentId);
    switch (operation.kind) {
      case "launch":
        if (!settings || operation.launch.agentId !== agentId)
          throw new Error("Missing or mismatched native launch settings");
        return launch({ ...operation.launch, ...settings });
      case "attach": {
        const channel = await new Promise<net.Socket>((resolve, reject) => {
          const socket = net.createConnection(hostFile(dir, "socket"));
          const timer = setTimeout(
            () => socket.destroy(new Error("connect timed out")),
            CONNECT_TIMEOUT_MS
          );
          socket.once("connect", () => {
            clearTimeout(timer);
            resolve(socket);
          });
          socket.once("error", (err) => {
            clearTimeout(timer);
            reject(err);
          });
        });
        return { channel };
      }
      case "alive": {
        const pid = await readPid(dir);
        return { value: pid !== null && pidAlive(pid) };
      }
      case "stop":
        await stop(agentId, operation.force);
        return {};
      case "discard":
        await rm(dir, { recursive: true, force: true });
        return {};
      case "log":
        return { value: await readLogTail(agentId) };
    }
  }
  return {
    requestSession,
    checkoutRelease: localCheckoutRelease,
    resolveLaunchDirectory,
    canonicalPath: (directory: string) => realpath(directory).catch(() => null),
    resolveWorkspace,
    resolveProjectRoot,
    inferRepositoryUrl,
    bindWorkspace: (
      agentId: string,
      directory: Parameters<typeof workspace.bind>[1],
      request: Parameters<typeof workspace.bind>[2]
    ) => workspace.bind(stateDir(agentId), directory, request),
    prepareWorkspace: (
      agentId: string,
      directory: Parameters<typeof workspace.prepare>[1],
      request: Parameters<typeof workspace.prepare>[2],
      progress: Parameters<typeof workspace.prepare>[3]
    ) => workspace.prepare(stateDir(agentId), directory, request, progress),
    resumeWorkspace: (
      agentId: string,
      progress: Parameters<typeof workspace.resume>[1]
    ) => workspace.resume(stateDir(agentId), progress),
    async listHosted() {
      let ids: string[] = [];
      try {
        ids = await readdir(agentStateRoot);
      } catch {
        return [];
      }
      const hosted: string[] = [];
      for (const id of ids) {
        const pid = await readPid(stateDir(id));
        if (pid && pidAlive(pid)) hosted.push(id);
      }
      return hosted;
    },

    async hostPid(agentId: string) {
      const pid = await readPid(stateDir(agentId));
      return pid && pidAlive(pid) ? pid : null;
    },
  };
}
