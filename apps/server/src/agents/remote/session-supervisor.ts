import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync } from "node:fs";
import {
  chmod,
  chown,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import { hostFile, type HostLaunch } from "../acp/host-protocol.js";
import {
  MANAGED_WORKSPACE,
  type Command,
  type RunnerRepository,
} from "./protocol.js";
import { parseRepository } from "./repository.js";
import {
  createSessionProcesses,
  parseSessionIdentity,
  type SessionIdentity,
  type SessionProcesses,
} from "./session-processes.js";
import {
  missingPath,
  prepareScratchSession,
  RunnerRepositories,
  type WorkloadCommand,
} from "./session-storage.js";

// Use the old storage name for existing prototype bindings. Other wire IDs
// never enter a filesystem path, even when they look like a relative path.
export function runnerStorageKey(agentId: string): string {
  return /^agt_[a-z0-9]+$/.test(agentId)
    ? agentId
    : `opaque-${createHash("sha256").update(agentId).digest("base64url")}`;
}

type LaunchCommand = Extract<Command, { kind: "launch" }>;

type SupervisorOptions = {
  state: string;
  uid: number;
  gid: number;
  ca: string;
  bins: HostLaunch["bins"];
  env: NodeJS.ProcessEnv;
  workspaces: ReadonlySet<string>;
  hostCommand: () => string[];
  asWorkload: WorkloadCommand;
};

const managedBinding = "\0managed";
const readOptional = (file: string) =>
  readFile(file, "utf8").catch(missingPath);

async function ownedDirectory(dir: string, mode: number) {
  const entry = await lstat(dir);
  if (
    !entry.isDirectory() ||
    entry.uid !== process.getuid?.() ||
    entry.mode & 0o022
  )
    throw new Error(
      "Runner state directories must be owned by the supervisor."
    );
  await chmod(dir, mode);
}

export async function createSessionSupervisor(
  config: SupervisorOptions,
  processes: SessionProcesses = createSessionProcesses(
    config.uid,
    config.asWorkload
  )
) {
  const { asWorkload, env } = config;
  const managedWorkspace = config.workspaces.size === 0;
  await mkdir(config.state, { recursive: true, mode: 0o700 });
  await ownedDirectory(config.state, 0o711);
  const storage = await realpath(config.state);
  const bindings = path.join(storage, "bindings");
  await mkdir(bindings, { mode: 0o700, recursive: true });
  await ownedDirectory(bindings, 0o700);
  const release = processes.acquire(path.join(bindings, ".lock"));
  const hostRoot = path.join(storage, "hosts");
  const logs = path.join(bindings, "logs");
  const sessions = path.join(storage, "sessions");
  const cache = path.join(storage, "repositories");
  try {
    for (const [root, mode] of [
      [logs, 0o700],
      [hostRoot, 0o711],
      [sessions, 0o711],
      [cache, 0o711],
    ] as const) {
      await mkdir(root, { mode, recursive: true });
      await ownedDirectory(root, mode);
    }
  } catch (error) {
    release();
    throw error;
  }
  const repositories = new RunnerRepositories(
    cache,
    config.uid,
    config.gid,
    asWorkload
  );
  const operations = new Map<string, Promise<unknown>>();

  function serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const pending = (operations.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(operation);
    operations.set(key, pending);
    return pending.finally(() => {
      if (operations.get(key) === pending) operations.delete(key);
    });
  }

  async function writePrivateState(file: string, contents: string) {
    const temp = path.join(bindings, `.pending-${randomUUID()}`);
    try {
      const handle = await open(temp, "wx", 0o600);
      try {
        await handle.writeFile(contents);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, file);
      const directory = await open(
        bindings,
        constants.O_RDONLY | constants.O_DIRECTORY
      );
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await rm(temp, { force: true });
    }
  }

  const readBinding = (key: string) => readOptional(path.join(bindings, key));
  const retireFile = (key: string) => path.join(bindings, `${key}.retired`);
  const repositoryFile = (key: string) =>
    path.join(bindings, `${key}.repository`);
  const markerFile = (key: string) => path.join(bindings, `${key}.owner`);
  const identityFile = (key: string) => path.join(bindings, `${key}.host`);
  function managedTarget(workspace: string) {
    if (managedWorkspace && workspace === MANAGED_WORKSPACE) return true;
    if (!config.workspaces.has(workspace))
      throw new Error("Unknown runner workspace");
    return false;
  }

  async function readIdentity(key: string) {
    const record = await readOptional(identityFile(key));
    return record === null ? null : parseSessionIdentity(record);
  }

  async function cleanHost(key: string, identity: SessionIdentity | null) {
    if (identity) {
      await processes.cleanup(identity);
      // Unlink only after all known descendants have gone.
      await rm(identityFile(key), { force: true });
    }
  }

  async function cleanLegacyHost(key: string) {
    const legacy = await readOptional(markerFile(key));
    if (legacy) {
      await processes.cleanupLegacy(legacy);
      await rm(markerFile(key), { force: true });
    }
  }

  function checkUntrackedSocket(dir: string) {
    const originalPath = path.join(config.state, "hosts", path.basename(dir));
    if (
      processes.socketInUse(hostFile(dir, "socket")) ||
      (originalPath !== dir &&
        processes.socketInUse(hostFile(originalPath, "socket")))
    )
      throw new Error(
        "Runner cannot verify ownership of the existing guest host."
      );
  }

  async function removeGuestDirectory(dir: string) {
    const entry = await lstat(dir).catch(missingPath);
    if (!entry) return;
    if (!entry.isDirectory())
      throw new Error("Invalid runner session directory.");
    if (entry.uid === process.getuid?.()) {
      // Startup can fail before handing the private directory over.
      await rm(dir, { force: true, recursive: true });
      return;
    }
    await asWorkload("/usr/bin/find", [dir, "-mindepth", "1", "-delete"]);
    await rmdir(dir);
  }

  async function discardManaged(key: string) {
    await writePrivateState(retireFile(key), "");
    const session = path.join(sessions, key);
    const stored = await readOptional(repositoryFile(key));
    const repository =
      stored === null ? null : (JSON.parse(stored) as RunnerRepository | null);
    if (repository) await repositories.remove(session, repository);
    await removeGuestDirectory(session);
    await rm(repositoryFile(key), { force: true });
    await rm(path.join(logs, key), { force: true });
  }

  async function launch(
    command: LaunchCommand,
    cwd: string | undefined,
    key: string
  ) {
    const { agentId, workspace } = command;
    const { mcp } = command.launch;
    const mcpUrl = mcp === undefined ? undefined : new URL(mcp.url);
    if (mcpUrl && (mcpUrl.protocol !== "https:" || !mcp?.token)) {
      throw new Error("Remote service MCP requires HTTPS and a scoped token.");
    }
    const managed = managedTarget(workspace);
    if (!managed && command.launch.repository !== undefined)
      throw new Error("Repository checkout requires a managed runner session.");
    if (managed && (await readOptional(retireFile(key))) !== null)
      throw new Error("This runner session has been archived.");

    const binding = await readBinding(key);
    const bindingValue = managed ? managedBinding : workspace;
    if (binding === null)
      await writePrivateState(path.join(bindings, key), bindingValue);
    else if (binding !== bindingValue)
      throw new Error("Agent is not bound to this workspace");
    const identity = await readIdentity(key);
    if (identity && processes.alive(identity))
      throw new Error("Runner already has a host for this agent");
    await cleanHost(key, identity);
    checkUntrackedSocket(path.join(hostRoot, key));
    await cleanLegacyHost(key);
    if (managed) {
      const parsed =
        command.launch.repository === undefined
          ? null
          : parseRepository(command.launch.repository);
      if (parsed && !parsed.url)
        throw new Error("Missing runner repository URL.");
      const repository = parsed?.url
        ? { url: parsed.url, checkout: parsed.checkout }
        : null;
      const encoded = JSON.stringify(repository);
      const stored = await readOptional(repositoryFile(key));
      if (stored !== null && stored !== encoded)
        throw new Error(
          "This runner session is bound to a different checkout."
        );
      if (stored === null)
        await writePrivateState(repositoryFile(key), encoded);
      cwd = await prepareScratchSession(sessions, key, config.uid, config.gid);
      if (repository) cwd = await repositories.prepare(cwd, repository);
    }
    if (!cwd || (!managed && !(await stat(cwd)).isDirectory()))
      throw new Error("Guest workspace is unavailable");
    const dir = path.join(hostRoot, key);
    const files = path.join(dir, "files");
    const { repository: _repository, ...launchOptions } = command.launch;
    const launch: HostLaunch = {
      ...launchOptions,
      agentId,
      cwd,
      bins: config.bins,
      env: {
        DISPATCH_AGENT_ID: agentId,
        DISPATCH_FILES_DIR: files,
        ...(mcpUrl ? { DISPATCH_API_URL: mcpUrl.origin } : {}),
        NODE_EXTRA_CA_CERTS: config.ca,
      },
      pathPrefix: [],
      reportTurnActivity: true,
    };
    // Write only into a fresh directory: a previous CLI account could have
    // replaced anything under its old host directory with symlinks.
    await removeGuestDirectory(dir);
    await mkdir(dir, { mode: 0o700 });
    await mkdir(files, { mode: 0o700 });
    await chown(files, config.uid, config.gid);
    await writeFile(hostFile(dir, "launch"), JSON.stringify(launch), {
      mode: 0o600,
    });
    await chown(hostFile(dir, "launch"), config.uid, config.gid);
    await chown(dir, config.uid, config.gid);

    const log = openSync(path.join(logs, key), "a", 0o600);
    try {
      const host = config.hostCommand();
      if (!host[0]) throw new Error("Runner host executable is missing");
      await processes.spawn(
        [...host, "--state", dir],
        cwd,
        env,
        log,
        (identity) =>
          writePrivateState(identityFile(key), JSON.stringify(identity)),
        (identity) => {
          void serialize(key, async () => {
            const current = await readIdentity(key);
            if (
              current?.marker === identity.marker &&
              !processes.alive(current)
            )
              await cleanHost(key, current);
          }).catch((error) =>
            console.error("Guest host descendant cleanup:", error.message)
          );
        }
      );
    } finally {
      closeSync(log);
    }
  }

  async function bound(key: string, workspace: string) {
    const binding = await readBinding(key);
    return binding === (managedTarget(workspace) ? managedBinding : workspace);
  }

  async function cleanExited(key: string) {
    const current = await readIdentity(key);
    if (current && !processes.alive(current)) await cleanHost(key, current);
  }

  async function trackedKeys() {
    return (await readdir(bindings))
      .filter((file) =>
        /^(agt_[a-z0-9]+|opaque-[A-Za-z0-9_-]{43})\.host$/.test(file)
      )
      .map((file) => file.slice(0, -5));
  }

  // Recovered hosts have no ChildProcess exit event. Keep descendant cleanup
  // independent of the service connection and isolate failures by session.
  let sweeping = false;
  const sweep = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    void trackedKeys()
      .then((keys) =>
        Promise.allSettled(
          keys.map((key) => serialize(key, () => cleanExited(key)))
        )
      )
      .then((results) => {
        for (const result of results) {
          if (result.status === "rejected")
            console.error(
              "Guest host descendant cleanup:",
              result.reason.message
            );
        }
      })
      .catch((error) => console.error("Guest host inventory:", error.message))
      .finally(() => {
        sweeping = false;
      });
  }, 5_000);
  sweep.unref();

  return {
    launch(command: LaunchCommand, cwd: string | undefined) {
      const key = runnerStorageKey(command.agentId);
      return serialize(key, () => launch(command, cwd, key));
    },
    async alive(agentId: string, workspace: string) {
      const key = runnerStorageKey(agentId);
      return serialize(key, async () => {
        if (!(await bound(key, workspace))) return false;
        const identity = await readIdentity(key);
        return identity !== null && processes.alive(identity);
      });
    },
    attach(agentId: string, workspace: string) {
      const key = runnerStorageKey(agentId);
      return serialize(key, async () => {
        if (!(await bound(key, workspace)))
          throw new Error("Agent is not bound to this workspace");
        const identity = await readIdentity(key);
        if (!identity || !processes.alive(identity)) return null;

        // Open the socket inode without following a workload-created symlink.
        // Linux connect through /proc/self/fd pins the checked inode, even if
        // the workload replaces the pathname before connect completes.
        const linuxOpenPath = 0x200000; // O_PATH is not exposed by Node.
        let fd: number;
        try {
          fd = openSync(
            hostFile(path.join(hostRoot, key), "socket"),
            linuxOpenPath | constants.O_NOFOLLOW
          );
        } catch (error) {
          throw new Error("Guest host socket is unavailable", { cause: error });
        }
        try {
          const socket = fstatSync(fd);
          if (!socket.isSocket() || socket.uid !== config.uid)
            throw new Error("Guest host socket is unavailable");
          if (!processes.alive(identity)) {
            closeSync(fd);
            return null;
          }
          const channel = createConnection(`/proc/self/fd/${fd}`);
          const releaseSocket = () => {
            channel.off("connect", releaseSocket);
            channel.off("close", releaseSocket);
            closeSync(fd);
          };
          channel.once("connect", releaseSocket);
          channel.once("close", releaseSocket);
          return channel;
        } catch (error) {
          closeSync(fd);
          throw error;
        }
      });
    },
    stop(agentId: string, workspace: string, force: boolean) {
      const key = runnerStorageKey(agentId);
      return serialize(key, async () => {
        if (!(await bound(key, workspace))) {
          if (managedTarget(workspace) && (await readBinding(key)) === null)
            return;
          throw new Error("Agent is not bound to this workspace");
        }
        const dir = path.join(hostRoot, key);
        const identity = await readIdentity(key);
        if (identity) await processes.stop(identity, force);
        await cleanHost(key, identity);
        checkUntrackedSocket(dir);
        await cleanLegacyHost(key);
      });
    },
    discard(agentId: string, workspace: string) {
      const key = runnerStorageKey(agentId);
      return serialize(key, async () => {
        const managed = managedTarget(workspace);
        if (!(await bound(key, workspace))) {
          if (managed && (await readBinding(key)) === null) {
            await writePrivateState(retireFile(key), "");
            return;
          }
          throw new Error("Agent is not bound to this workspace");
        }
        const identity = await readIdentity(key);
        if (identity && processes.alive(identity))
          throw new Error("Stop the guest host before discarding it");
        const dir = path.join(hostRoot, key);
        await cleanHost(key, identity);
        checkUntrackedSocket(dir);
        await cleanLegacyHost(key);
        if (managed) await discardManaged(key);
        await removeGuestDirectory(dir);
        await rm(path.join(bindings, key), { force: true });
      });
    },
    async log(agentId: string, workspace: string) {
      const key = runnerStorageKey(agentId);
      if (!(await bound(key, workspace)))
        throw new Error("Agent is not bound to this workspace");
      const identity = await readIdentity(key);
      const live = identity && processes.alive(identity);
      const log = await readFile(path.join(logs, key), "utf8").catch(
        missingPath
      );
      return `Guest agent host ${live ? "log" : "exited"}.${log ? "\n" + log.slice(-2048) : ""}`;
    },
    async isBound(agentId: string, workspace: string) {
      return bound(runnerStorageKey(agentId), workspace);
    },
    async liveDirectories() {
      const dirs = await Promise.all(
        (await trackedKeys()).map(async (key) => {
          const binding = await readBinding(key);
          if (
            binding === null ||
            !(managedWorkspace
              ? binding === managedBinding
              : config.workspaces.has(binding))
          )
            return null;
          const identity = await readIdentity(key);
          return identity && processes.alive(identity)
            ? path.join(hostRoot, key)
            : null;
        })
      );
      return dirs.filter((dir) => dir !== null);
    },
    close() {
      clearInterval(sweep);
      release();
    },
  };
}
