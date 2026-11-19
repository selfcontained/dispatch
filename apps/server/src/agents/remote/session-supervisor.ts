import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, type Stats } from "node:fs";
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
  writeFile,
} from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import { hostFile, type HostLaunch } from "../acp/host-protocol.js";
import {
  MANAGED_WORKSPACE,
  isOpaqueId,
  type Command,
  type LaunchProgress,
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

type LaunchCommand = Extract<Command, { kind: "launch" }> & {
  launch: { useWorktreeOf?: unknown };
};

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
  prepareDependencies?: (cwd: string) => Promise<boolean>;
};

const managedBinding = "\0managed";
const sharedBindingPrefix = managedBinding + ":";
const storageKeyPattern = /^(agt_[a-z0-9]+|opaque-[A-Za-z0-9_-]{43})$/;
const readOptional = (file: string) =>
  readFile(file, "utf8").catch(missingPath);

function checkoutOwner(binding: string | null) {
  if (!binding?.startsWith(sharedBindingPrefix)) return null;
  const key = binding.slice(sharedBindingPrefix.length);
  if (!storageKeyPattern.test(key))
    throw new Error("Invalid runner checkout binding.");
  return key;
}

const logTailBytes = 2 * 1024;

async function readLogTail(file: string) {
  const handle = await open(file, "r").catch(missingPath);
  if (!handle) return "";
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - logTailBytes);
    const tail = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(tail, 0, tail.length, start);
    let first = 0;
    // The window may start inside a UTF-8 code point.
    while (start > 0 && first < bytesRead && (tail[first]! & 0xc0) === 0x80)
      first++;
    return tail.toString("utf8", first, bytesRead);
  } finally {
    await handle.close();
  }
}

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

  function withLaunchLocks<T>(keys: string[], operation: () => Promise<T>) {
    // Acquire the launch, author, and checkout keys in a stable order.
    const ordered = [...new Set(keys)].sort();
    const acquire = (index: number): Promise<T> => {
      const key = ordered[index];
      return key === undefined
        ? operation()
        : serialize(key, () => acquire(index + 1));
    };
    return acquire(0);
  }

  async function syncBindings() {
    const directory = await open(
      bindings,
      constants.O_RDONLY | constants.O_DIRECTORY
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
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
      await syncBindings();
    } finally {
      await rm(temp, { force: true });
    }
  }

  const readBinding = (key: string) => readOptional(path.join(bindings, key));
  const retireFile = (key: string) => path.join(bindings, `${key}.retired`);
  const repositoryFile = (key: string) =>
    path.join(bindings, `${key}.repository`);
  const planFile = (key: string) => path.join(bindings, `${key}.checkout-plan`);
  const dependenciesFile = (key: string) =>
    path.join(bindings, `${key}.dependencies`);
  const cwdFile = (key: string) => path.join(bindings, `${key}.cwd`);
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

  async function checkedDirectory(dir: string) {
    const entry = await lstat(dir).catch(missingPath);
    if (!entry?.isDirectory() || (await realpath(dir)) !== dir)
      throw new Error("The runner session checkout is unavailable.");
    return entry;
  }

  async function configuredDirectory(key: string, configuredCwd?: string) {
    const stored = await readOptional(cwdFile(key));
    const current =
      configuredCwd === undefined ? undefined : await realpath(configuredCwd);
    if (stored !== null && current !== undefined && current !== stored)
      throw new Error("Agent is bound to a different configured directory.");
    const cwd = stored ?? current;
    if (cwd === undefined)
      throw new Error("The runner session checkout is unavailable.");
    await checkedDirectory(cwd);
    if (stored === null) await writePrivateState(cwdFile(key), cwd);
    return cwd;
  }

  function checkoutParentIsProtected(entry: Stats | null) {
    return (
      entry !== null &&
      entry.uid === process.getuid?.() &&
      (entry.mode & 0o777) === 0o711
    );
  }

  async function managedDirectory(key: string) {
    const stored = await readOptional(repositoryFile(key));
    if (stored === null)
      throw new Error("The runner session checkout is unavailable.");
    const session = path.join(sessions, key);
    const entry = await checkedDirectory(session);
    if (JSON.parse(stored) === null) return session;
    const checkout = path.join(session, "checkout");
    await checkedDirectory(checkout);
    if (checkoutParentIsProtected(entry)) return checkout;
    // The parent of a Git checkout must be supervisor-owned so a workload
    // cannot swap the verified checkout for a symlink after it is resolved.
    // Legacy sessions get this protection when first inspected or borrowed.
    await chown(session, process.getuid!(), process.getgid!());
    await chmod(session, 0o711);
    await checkedDirectory(checkout);
    return checkout;
  }

  async function hasBorrowers(key: string) {
    for (const entry of await readdir(bindings)) {
      if (
        storageKeyPattern.test(entry) &&
        checkoutOwner(await readBinding(entry)) === key
      )
        return true;
    }
    return false;
  }

  async function discardManagedCheckout(key: string) {
    if (await hasBorrowers(key))
      throw new Error("Runner checkout is still in use by a borrower.");
    const session = path.join(sessions, key);
    const stored = await readOptional(repositoryFile(key));
    const repository =
      stored === null ? null : (JSON.parse(stored) as RunnerRepository | null);
    // Remove the directory before unregistering it so the workload never
    // regains write access to a protected checkout parent.
    if (
      repository &&
      checkoutParentIsProtected(await lstat(session).catch(missingPath))
    )
      await removeGuestDirectory(path.join(session, "checkout"));
    await removeGuestDirectory(session);
    if (repository) await repositories.remove(session, repository);
    await rm(repositoryFile(key), { force: true });
    await rm(planFile(key), { force: true });
    await rm(dependenciesFile(key), { force: true });
  }

  async function launch(
    command: LaunchCommand,
    cwd: string | undefined,
    key: string,
    owner: string | null,
    progress?: (step: LaunchProgress) => void
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
    const bindingValue = owner
      ? sharedBindingPrefix + owner
      : managed
        ? managedBinding
        : workspace;
    if (binding !== null && binding !== bindingValue)
      throw new Error("Agent is not bound to this workspace or checkout");
    progress?.({ phase: "workspace" });
    if (owner) {
      if ((await readBinding(owner)) !== managedBinding)
        throw new Error("The author does not own a checkout on this runner.");
      if (binding === null && (await readOptional(retireFile(owner))) !== null)
        throw new Error("The author checkout has been archived.");
      cwd = await managedDirectory(owner);
    }
    if (binding === null)
      await writePrivateState(path.join(bindings, key), bindingValue);
    const identity = await readIdentity(key);
    if (identity && processes.alive(identity))
      throw new Error("Runner already has a host for this agent");
    await cleanHost(key, identity);
    checkUntrackedSocket(path.join(hostRoot, key));
    await cleanLegacyHost(key);
    if (managed && !owner) {
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
      const session = path.join(sessions, key);
      const entry = await lstat(session).catch(missingPath);
      if (entry) await checkedDirectory(session);
      const protectedParent = repository && checkoutParentIsProtected(entry);
      cwd = protectedParent
        ? session
        : await prepareScratchSession(sessions, key, config.uid, config.gid);
      if (repository) {
        const checkout = path.join(cwd, "checkout");
        if (await lstat(checkout).catch(missingPath))
          await checkedDirectory(checkout);
        await repositories.prepare(cwd, repository, {
          read: async () => {
            const storedPlan = await readOptional(planFile(key));
            return storedPlan === null ? null : JSON.parse(storedPlan);
          },
          write: (plan) =>
            writePrivateState(planFile(key), JSON.stringify(plan)),
          clear: () => rm(planFile(key), { force: true }),
        });
        cwd = await managedDirectory(key);
        if (
          command.launch.prepareWorkspace &&
          config.prepareDependencies &&
          (await readOptional(dependenciesFile(key))) === null
        ) {
          progress?.({ phase: "dependencies" });
          const installed = await config
            .prepareDependencies(cwd)
            .catch(() => false);
          if (installed) await writePrivateState(dependenciesFile(key), "done");
          progress?.({
            phase: "dependencies",
            status: installed ? "done" : "failed",
          });
        }
      }
    }
    if (!cwd) throw new Error("Guest workspace is unavailable");
    if (!managed) {
      if (command.launch.useWorktreeOf === undefined)
        cwd = command.launch.prepareWorkspace
          ? (await asWorkload("realpath", ["-e", "--", cwd])).trimEnd()
          : await realpath(cwd);
      if (command.launch.prepareWorkspace)
        await asWorkload("test", ["-d", cwd]);
      await checkedDirectory(cwd);
      await writePrivateState(cwdFile(key), cwd);
    }
    progress?.({ phase: "ready" });
    const dir = path.join(hostRoot, key);
    const files = path.join(dir, "files");
    const {
      repository: _repository,
      useWorktreeOf: _owner,
      prepareWorkspace: _preparation,
      ...launchOptions
    } = command.launch;
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
    return matchesWorkspace(await readBinding(key), workspace);
  }

  function matchesWorkspace(binding: string | null, workspace: string) {
    return managedTarget(workspace)
      ? binding === managedBinding || checkoutOwner(binding) !== null
      : binding === workspace;
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
    async launch(
      command: LaunchCommand,
      cwd: string | undefined,
      progress?: (step: LaunchProgress) => void
    ) {
      const key = runnerStorageKey(command.agentId);
      const { useWorktreeOf } = command.launch;
      if (useWorktreeOf === undefined)
        return serialize(key, () => launch(command, cwd, key, null, progress));
      if (!isOpaqueId(useWorktreeOf) || useWorktreeOf === command.agentId)
        throw new Error("Invalid author for a shared runner checkout.");
      if (command.launch.repository !== undefined)
        throw new Error("A shared runner checkout cannot select a repository.");
      const { workspace } = command;
      const author = runnerStorageKey(useWorktreeOf);
      if (!managedTarget(workspace)) {
        return withLaunchLocks([key, author], async () => {
          if ((await readBinding(author)) !== workspace)
            throw new Error(
              "The author is not bound to this runner workspace."
            );
          if (cwd === undefined)
            throw new Error("Guest workspace is unavailable");
          return launch(
            command,
            await configuredDirectory(author, cwd),
            key,
            null,
            progress
          );
        });
      }
      const owner = checkoutOwner(await readBinding(author)) ?? author;
      if (owner === key)
        throw new Error("Invalid author for a shared runner checkout.");
      return withLaunchLocks([key, author, owner], async () => {
        if (
          author !== owner &&
          (checkoutOwner(await readBinding(author)) !== owner ||
            (await readOptional(retireFile(author))) !== null)
        )
          throw new Error("The author does not own a checkout on this runner.");
        return launch(command, cwd, key, owner, progress);
      });
    },
    checkoutDirectory(
      agentId: string,
      workspace: string,
      // Only the runner's configured path may supply a missing legacy cwd.
      configuredCwd?: string
    ): Promise<string> {
      const key = runnerStorageKey(agentId);
      return serialize(key, async () => {
        const managed = managedTarget(workspace);
        const binding = await readBinding(key);
        if (!matchesWorkspace(binding, workspace))
          throw new Error("Agent is not bound to this workspace");
        if (managed) {
          if ((await readOptional(retireFile(key))) !== null)
            throw new Error("This runner session has been archived.");
          const owner = checkoutOwner(binding);
          if (owner && (await readBinding(owner)) !== managedBinding)
            throw new Error(
              "The author does not own a checkout on this runner."
            );
          return managedDirectory(owner ?? key);
        }
        return configuredDirectory(key, configuredCwd);
      });
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
        if (managed) await writePrivateState(retireFile(key), "");
        const dir = path.join(hostRoot, key);
        await cleanHost(key, identity);
        checkUntrackedSocket(dir);
        await cleanLegacyHost(key);
        if (managed) {
          if (!checkoutOwner(await readBinding(key)))
            await discardManagedCheckout(key);
          await rm(path.join(logs, key), { force: true });
        } else {
          await rm(cwdFile(key), { force: true });
        }
        await removeGuestDirectory(dir);
        await rm(path.join(bindings, key), { force: true });
        if (managed) await syncBindings();
      });
    },
    async log(agentId: string, workspace: string) {
      const key = runnerStorageKey(agentId);
      if (!(await bound(key, workspace)))
        throw new Error("Agent is not bound to this workspace");
      const identity = await readIdentity(key);
      const live = identity && processes.alive(identity);
      const log = await readLogTail(path.join(logs, key));
      return `Guest agent host ${live ? "log" : "exited"}.${log ? "\n" + log : ""}`;
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
              ? binding === managedBinding || checkoutOwner(binding) !== null
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
