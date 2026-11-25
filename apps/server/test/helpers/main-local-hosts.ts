/*
 * A host started and stopped exactly as origin/main's app did, in process:
 * the fixture for hosts "an earlier build started". The app itself no longer
 * spawns or signals hosts (the local runner child does); tests use this to
 * prove the child adopts and drives what main left behind.
 */
import { execFile, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { SessionLifecycleOperation } from "@dispatch/runner-protocol";
import {
  killOwnedProcesses,
  ownedEnvironment,
} from "../../src/shared/process/owned-processes.js";
import { childProcessEnv } from "../../src/shared/process/child-environment.js";
import {
  hostCommand,
  loginShellCommand,
} from "@dispatch/runner/host/host-command";
import { preparePromptContext } from "@dispatch/runner/host/host-env";
import {
  hostFile,
  type HostLaunch,
} from "@dispatch/runner-client/host-framing";

export type MainLaunchSettings = Pick<
  HostLaunch,
  "cwd" | "env" | "bins" | "pathPrefix"
>;

const logger = { info() {}, warn() {}, error() {} };

const STOP_GRACE_MS = 8_000;
const KILL_GRACE_MS = 2_000;

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

export function mainLocalHosts(agentStateRoot: string) {
  function stateDir(agentId: string) {
    return path.join(agentStateRoot, agentId);
  }
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
      personaContext: await preparePromptContext(dir, input.personaContext),
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
  async function requestSession(
    operation: SessionLifecycleOperation,
    settings?: MainLaunchSettings
  ): Promise<{ launchExited?: () => boolean }> {
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
      case "attach":
      case "alive":
      case "log":
        throw new Error(`Not part of this fixture: ${operation.kind}`);
      case "stop":
        await stop(agentId, operation.force);
        return {};
      case "discard":
        await rm(dir, { recursive: true, force: true });
        return {};
    }
  }
  return {
    requestSession,
  };
}
