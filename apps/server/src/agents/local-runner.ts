import { execFile, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import { hostname, userInfo } from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { promisify } from "node:util";
import type { FastifyBaseLogger } from "fastify";
import {
  checkoutCommandTimeoutMs,
  isCheckoutCommand,
  remotePlacement,
  type SessionOperation,
  isSessionFileName,
  isSessionFilePath,
  type SessionLifecycleOperation,
} from "@dispatch/runner-protocol";
import {
  openBoundedSessionFile,
  readSessionFile,
} from "../files/session-file.js";
import {
  killOwnedProcesses,
  ownedEnvironment,
} from "../shared/process/owned-processes.js";
import { childProcessEnv } from "../shared/process/child-environment.js";
import { hostCommand, loginShellCommand } from "./acp/host-command.js";
import { preparePersonaContext } from "./acp/persona-context.js";
import { hostFile, type HostLaunch } from "./acp/host-protocol.js";

import {
  createWorkspacePreparation,
  resolveLaunchDirectory,
} from "./workspace.js";
import { resolveWorkspace } from "./workspace-target.js";
import { resolveProjectRoot } from "../projects/resolve-root.js";
import { localCheckoutRelease } from "./local-runner-checkout.js";
import { executeCheckoutCommand } from "./checkout-command-executor.js";
import { readCheckoutCommandFile } from "./checkout-inspection.js";
import type { AgentRecord } from "./types.js";
import { inferRepositoryUrl } from "./remote/repository.js";
import type { TerminalBackend } from "../terminal/manager.js";
import { spawnTerminal, type SpawnTerminal } from "../terminal/pty.js";

export type LocalLaunchSettings = Pick<
  HostLaunch,
  "cwd" | "env" | "bins" | "pathPrefix"
>;
type CheckoutCommandOperation = Extract<
  SessionOperation,
  { kind: "checkoutCommand" }
>;
type LocalCheckoutSettings = {
  checkout: Pick<AgentRecord, "id" | "cwd" | "worktreePath" | "workspacePath">;
  signal?: AbortSignal;
};

export type SessionResult = {
  value?: string | boolean;
  channel?: Duplex;
  launchExited?: () => boolean;
};

export const STOP_GRACE_MS = 8_000;
const KILL_GRACE_MS = 2_000;
const LOG_TAIL_LINES = 20;
const CONNECT_TIMEOUT_MS = 5_000;

export type NativeHostProcess = {
  sessionHandle: string;
  processState: "live" | "gone" | "stale";
};

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
  processState: NativeHostProcess["processState"];
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

function containsPath(directory: string, file: string) {
  const compare = (value: string) =>
    process.platform === "darwin"
      ? value.normalize("NFC").toLowerCase()
      : value;
  const relative = path.relative(compare(directory), compare(file));
  return (
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}

function realpathIfPresent(directory: string) {
  return realpath(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
}

/** In-process implementation of runner lifecycle operations for native agent hosts.
 * The native workload and the host service share an OS account. State
 * paths and host sockets must stay compatible with hosts from earlier versions.
 */
export function createLocalRunner(
  agentStateRoot: string,
  logger: FastifyBaseLogger,
  spawnPty: SpawnTerminal = spawnTerminal
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
  function terminalBackend(
    checkout: Pick<AgentRecord, "id" | "cwd" | "worktreePath" | "workspacePath">
  ): TerminalBackend {
    return async (output) => {
      stateDir(checkout.id);
      if (checkout.cwd.startsWith("runner://"))
        throw new Error("Invalid native terminal binding.");
      const cwd = await realpath(
        checkout.workspacePath ?? checkout.worktreePath ?? checkout.cwd
      );
      if (!(await stat(cwd)).isDirectory())
        throw new Error("Workspace directory is unavailable.");
      return {
        ...spawnPty(cwd, output),
        cwd,
        host: hostname(),
        user: userInfo().username,
      };
    };
  }

  async function deliverSessionFile(agentId: string, source: string) {
    stateDir(agentId);
    // The service resolved this registered attachment for the receiving
    // session. The existing host file is already visible to the workload.
    const name = path.basename(source);
    if (!isSessionFileName(name))
      throw new Error("Invalid session input file.");
    const { file } = await openBoundedSessionFile(
      await realpath(path.dirname(source)),
      name
    );
    await file.close();
    return source;
  }

  async function collectSessionFile(
    agentId: string,
    source: string,
    files: { root: string; ownDir: string; otherDirs: string[] }
  ) {
    stateDir(agentId);
    if (!isSessionFilePath(source))
      throw new Error("Invalid session output file path.");
    // Follow native aliases such as macOS /tmp, then open the resolved path
    // without following any links that appear after authorization.
    const requested = path.resolve(source);
    const [target, root, state] = await Promise.all([
      realpath(requested),
      realpathIfPresent(files.root),
      realpathIfPresent(agentStateRoot),
    ]);
    // Derive the permitted canonical child from the root. Resolving ownDir
    // separately would let a symlink to a different session claim its files.
    const ownRelative = path.relative(files.root, files.ownDir);
    const ownInRoot = containsPath(files.root, files.ownDir);
    if (
      containsPath(agentStateRoot, requested) ||
      (state && containsPath(state, target)) ||
      (containsPath(files.root, requested) &&
        !containsPath(files.ownDir, requested)) ||
      (root &&
        containsPath(root, target) &&
        (!ownInRoot || !containsPath(path.join(root, ownRelative), target)))
    ) {
      throw new Error("File path is outside the session's permitted files.");
    }
    for (const other of files.otherDirs) {
      const canonical = await realpathIfPresent(other);
      if (
        containsPath(other, requested) ||
        (canonical && containsPath(canonical, target))
      )
        throw new Error("File path is outside the session's permitted files.");
    }
    return readSessionFile(path.dirname(target), path.basename(target));
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
    const owned = ownedEnvironment(childProcessEnv());
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
    const { pid } = await inspectHostProcess(dir);
    if (pid) {
      const deadline = Date.now() + (force ? 0 : STOP_GRACE_MS);
      while (Date.now() < deadline && pidAlive(pid)) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (await hostPidMatches(pid, dir)) {
        signalGroup(pid, "SIGTERM");
        const killAt = Date.now() + KILL_GRACE_MS;
        while (Date.now() < killAt && pidAlive(pid)) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        if (await hostPidMatches(pid, dir)) signalGroup(pid, "SIGKILL");
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
    operation: SessionLifecycleOperation | CheckoutCommandOperation,
    settings?: LocalLaunchSettings | LocalCheckoutSettings
  ): Promise<SessionResult> {
    const { agentId } = operation;
    const dir = stateDir(agentId);
    switch (operation.kind) {
      case "launch":
        if (
          !settings ||
          !("cwd" in settings) ||
          operation.launch.agentId !== agentId
        )
          throw new Error("Missing or mismatched native launch settings");
        return launch({ ...operation.launch, ...settings });
      case "checkoutCommand": {
        if (
          !settings ||
          !("checkout" in settings) ||
          settings.checkout.id !== agentId ||
          remotePlacement(settings.checkout.cwd) ||
          !isCheckoutCommand(operation.operation)
        )
          throw new Error("Invalid native checkout command binding.");
        const { checkout, signal } = settings;
        const { operation: command } = operation;
        const launch = checkout.worktreePath ?? checkout.cwd;
        const moved = checkout.workspacePath;
        const cwd = command.checkout === "launch" ? launch : (moved ?? launch);
        if (command.checkout === "moved" && (!moved || moved === launch)) {
          if (command.kind === "run")
            throw new Error("The moved checkout is no longer selected.");
          return { value: "null" };
        }
        const deadline = new AbortController();
        const timer = setTimeout(
          () => deadline.abort(new Error("Checkout command timed out.")),
          checkoutCommandTimeoutMs(command.checkout)
        );
        try {
          return {
            value: JSON.stringify(
              await executeCheckoutCommand(
                cwd,
                agentId,
                command,
                (file) =>
                  readCheckoutCommandFile(cwd, file, {
                    exact: command.checkout !== "effective",
                  }),
                signal
                  ? AbortSignal.any([signal, deadline.signal])
                  : deadline.signal
              )
            ),
          };
        } finally {
          clearTimeout(timer);
        }
      }
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
        const { processState } = await inspectHostProcess(dir);
        return { value: processState === "live" };
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
    terminalBackend,
    deliverSessionFile,
    collectSessionFile,
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
    requestedWorktree: (agentId: string) =>
      workspace.requested(stateDir(agentId)),
    resumeWorkspace: (
      agentId: string,
      progress: Parameters<typeof workspace.resume>[1]
    ) => workspace.resume(stateDir(agentId), progress),
    async inspectHost(sessionHandle: string): Promise<NativeHostProcess> {
      const { processState } = await inspectHostProcess(
        stateDir(sessionHandle)
      );
      return { sessionHandle, processState };
    },

    async listHosted() {
      const entries = await readdir(agentStateRoot, {
        withFileTypes: true,
      }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      const hosted: string[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const { processState } = await inspectHostProcess(stateDir(entry.name));
        if (processState === "live") hosted.push(entry.name);
      }
      return hosted;
    },

    isHostPid: (agentId: string, pid: number) =>
      hostPidMatches(pid, stateDir(agentId)),

    async hostPid(agentId: string) {
      return (await inspectHostProcess(stateDir(agentId))).pid;
    },
  };
}
