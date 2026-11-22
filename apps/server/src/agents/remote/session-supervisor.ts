import type { CheckoutCommand } from "@dispatch/runner-protocol";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, openSync, type Stats } from "node:fs";
import {
  chmod,
  chown,
  lchown,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import type { BuildIdentity } from "../build-identity.js";
import { HOST_FILES, hostFile, type HostLaunch } from "../acp/host-protocol.js";
import { observeBoundCheckout } from "../checkout-observation.js";
import { probeGitContext } from "../../shared/git/git-context.js";
import type { CommandRunner } from "../../shared/lib/run-command.js";
import {
  MANAGED_WORKSPACE,
  isOpaqueId,
  isCheckoutPath,
  isSessionFileOperation,
  type SessionFileOperation,
  type SessionCheckout,
  type CheckoutObservation,
  type CheckoutRelease,
  type CheckoutReleaseResult,
  type CheckoutState,
  type SessionOperation,
  type Command,
  type LaunchProgress,
  type RunnerRepository,
  type RunnerEngine,
} from "./protocol.js";
import { parseRepository, repositoryUrl } from "./repository.js";
import {
  classifySessionIdentity,
  createSessionProcesses,
  openHostSocket,
  parseSessionIdentity,
  type CurrentSessionIdentity,
  type SessionIdentity,
  type SessionProcesses,
} from "./session-processes.js";
import {
  missingPath,
  prepareScratchSession,
  RunnerRepositories,
  type WorkloadCommand,
} from "./session-storage.js";

import {
  requiresQuiescence,
  runnerHandoff,
  type HandoffFormats,
  type RetainedHost,
} from "./update-handoff.js";

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

type CheckoutOperation = Extract<
  SessionOperation,
  { kind: "sessionCheckout" }
>["operation"];

type SupervisorOptions = {
  build: BuildIdentity;
  state: string;
  uid: number;
  gid: number;
  ca: string;
  bins: HostLaunch["bins"];
  resolveBins?: (engine: RunnerEngine) => Promise<HostLaunch["bins"]>;
  env: NodeJS.ProcessEnv;
  workspaces: ReadonlySet<string>;
  hostCommand: (dir: string) => string[];
  asWorkload: WorkloadCommand;
  githubCredentialHelper?: () => Promise<string>;
  observeCheckout?: (cwd: string, scratch: boolean) => Promise<CheckoutState>;
  prepareDependencies?: (cwd: string) => Promise<boolean>;
  /** False while the update fence holds process admission closed. */
  mayStartProcess?: () => boolean;
};

/**
 * Dispatch's durable identity for one launch attempt, saved before the
 * launch starts any process. A repeat of the same ID (its reply was lost)
 * resumes from the stage recorded here instead of running again.
 */
type LaunchRecord = {
  launchId: string;
  stage: "preparing" | "spawning";
  /** The host this attempt spawned, once it reached `spawning`. */
  hostInstanceId?: string;
  /** Dependency preparation for this attempt. `started` alone is unknown. */
  dependencies?: "started" | "done" | "failed";
};

/** A record that does not parse is no record: the launch runs as new. Its
 * ID is only ever compared with the validated ID on the wire. */
function parseLaunchRecord(raw: string | null): LaunchRecord | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      (value.stage !== "preparing" && value.stage !== "spawning") ||
      (value.hostInstanceId !== undefined &&
        typeof value.hostInstanceId !== "string")
    )
      return null;
    return {
      launchId: value.launchId as string,
      stage: value.stage,
      ...(value.hostInstanceId !== undefined && {
        hostInstanceId: value.hostInstanceId as string,
      }),
      ...(value.dependencies !== undefined && {
        dependencies: value.dependencies as LaunchRecord["dependencies"],
      }),
    };
  } catch {
    return null;
  }
}

export const UNRECONCILED_DEPENDENCIES =
  "The runner restarted while preparing dependencies for this launch, so " +
  "their result is unknown. They were not run again. Start the agent to retry.";

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

function containsDirectory(root: string, dir: string) {
  return dir === root || dir.startsWith(root === "/" ? root : root + "/");
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

async function ownedDirectory(dir: string, mode: number, gid?: number) {
  const entry = await lstat(dir);
  if (
    !entry.isDirectory() ||
    entry.uid !== process.getuid?.() ||
    entry.mode & 0o022
  )
    throw new Error(
      "Runner state directories must be owned by the supervisor."
    );
  if (gid !== undefined && entry.gid !== gid) await chown(dir, entry.uid, gid);
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
  // Tools such as Bun open checkout ancestors for reading. Keep them
  // supervisor-owned and give the workload group read access.
  const checkoutAncestorMode = 0o751;
  await ownedDirectory(config.state, checkoutAncestorMode, config.gid);
  const storage = await realpath(config.state);
  const installRoot = path.dirname(storage);
  if (process.getuid?.() === 0 && installRoot === "/var/lib/dispatch-runner") {
    // Upgrading with an older installer still repairs the shared Linux root
    // when the new supervisor starts.
    await ownedDirectory(installRoot, 0o755);
  }
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
      [sessions, checkoutAncestorMode],
      [cache, 0o711],
    ] as const) {
      await mkdir(root, { mode, recursive: true });
      await ownedDirectory(
        root,
        mode,
        root === sessions ? config.gid : undefined
      );
    }
    // Idle hosts can survive an upgrade. Repair existing protected parents
    // before those hosts resume work, leaving workload-owned scratch alone.
    for (const key of await readdir(sessions)) {
      if (!isOpaqueId(key)) continue;
      const parent = path.join(sessions, key);
      const entry = await lstat(parent);
      if (
        entry.isDirectory() &&
        entry.uid === process.getuid?.() &&
        (entry.mode & 0o777) === 0o711
      ) {
        await ownedDirectory(parent, checkoutAncestorMode, config.gid);
      }
    }
  } catch (error) {
    release();
    throw error;
  }
  const repositories = new RunnerRepositories(
    cache,
    config.uid,
    config.gid,
    asWorkload,
    config.githubCredentialHelper
  );
  const operations = new Map<string, Promise<unknown>>();
  // Workload commands throw on failure; report an allowed non-zero exit
  // instead so shared git probes can take their fallback paths.
  const workloadRunner: CommandRunner = async (command, args, options) => {
    try {
      const stdout =
        (await asWorkload(command, args, { git: command === "git" })) ?? "";
      return {
        exitCode: 0,
        stdout: options?.trimOutput === false ? stdout : stdout.trim(),
        stderr: "",
      };
    } catch (error) {
      const exitCode = options?.allowedExitCodes?.find((code) => code !== 0);
      if (exitCode === undefined) throw error;
      return { exitCode, stdout: "", stderr: "" };
    }
  };

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
  const releaseFile = (key: string) => path.join(bindings, `${key}.released`);
  const retireFile = (key: string) => path.join(bindings, `${key}.retired`);
  const repositoryFile = (key: string) =>
    path.join(bindings, `${key}.repository`);
  const planFile = (key: string) => path.join(bindings, `${key}.checkout-plan`);
  const dependenciesFile = (key: string) =>
    path.join(bindings, `${key}.dependencies`);
  const cwdFile = (key: string) => path.join(bindings, `${key}.cwd`);
  const selectedFile = (key: string) =>
    path.join(bindings, `${key}.selected-cwd`);
  const borrowedFile = (key: string) =>
    path.join(bindings, `${key}.borrowed-cwd`);
  const markerFile = (key: string) => path.join(bindings, `${key}.owner`);
  const identityFile = (key: string) => path.join(bindings, `${key}.host`);
  const launchFile = (key: string) => path.join(bindings, `${key}.launch`);
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

  const socketPath = (key: string) =>
    hostFile(path.join(hostRoot, key), "socket");

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

  function hasNamedSocket(dir: string) {
    const originalPath = path.join(config.state, "hosts", path.basename(dir));
    return (
      processes.socketInUse(hostFile(dir, "socket")) ||
      (originalPath !== dir &&
        processes.socketInUse(hostFile(originalPath, "socket")))
    );
  }

  function checkUntrackedSocket(dir: string) {
    if (hasNamedSocket(dir))
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

  async function resetGuestHost(dir: string, files: string) {
    const entry = await lstat(dir).catch(missingPath);
    if (entry) {
      if (!entry.isDirectory())
        throw new Error("Invalid runner session directory.");
      // The supervisor owns the parent of dir. Take back dir before changing
      // its entries so the workload cannot swap in links during setup.
      const uid = process.getuid!();
      if (entry.uid !== uid) await chown(dir, uid, process.getgid!());
      await chmod(dir, 0o700);
      for (const name of Object.values(HOST_FILES)) {
        await unlink(path.join(dir, name)).catch(missingPath);
      }
    } else {
      await mkdir(dir, { mode: 0o700 });
    }

    const shared = await lstat(files).catch(missingPath);
    if (shared) {
      if (!shared.isDirectory())
        throw new Error("Invalid runner session files directory.");
      if (shared.uid !== config.uid || shared.gid !== config.gid) {
        // The workload account changed. Hand over only this directory: dir
        // pins its name, but the previous account chose everything below it,
        // including links and directories moved in from elsewhere, so a
        // recursive chown as root could give away files it never owned.
        // 0700 also shuts that account out of what it still owns inside.
        await lchown(files, process.getuid!(), process.getgid!());
        await chmod(files, 0o700);
        await lchown(files, config.uid, config.gid);
      }
    } else {
      await mkdir(files, { mode: 0o700 });
      await chown(files, config.uid, config.gid);
    }
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
      entry.gid === config.gid &&
      (entry.mode & 0o777) === checkoutAncestorMode
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
    await chown(session, process.getuid!(), config.gid);
    await chmod(session, checkoutAncestorMode);
    await checkedDirectory(checkout);
    return checkout;
  }

  async function initialDirectory(
    key: string,
    workspace: string,
    configuredCwd?: string
  ) {
    const binding = await readBinding(key);
    if (!matchesWorkspace(binding, workspace))
      throw new Error("Agent is not bound to this workspace");
    const managed = managedTarget(workspace);
    const owner = checkoutOwner(binding);
    if (managed && (await readOptional(retireFile(key))) !== null)
      throw new Error("This runner session has been archived.");
    if (owner && (await readBinding(owner)) !== managedBinding)
      throw new Error("The author does not own a checkout on this runner.");
    const launch = managed
      ? await managedDirectory(owner ?? key)
      : await configuredDirectory(key, configuredCwd);
    const borrowed = await readOptional(borrowedFile(key));
    return borrowed && borrowed !== launch
      ? authorizedDirectory(borrowed, launch, managed, owner ?? key)
      : launch;
  }

  /** Whether `dir` is inside a session's protected `checkout` subtree. */
  async function isSessionCheckout(dir: string) {
    const [key, name] = path.relative(sessions, dir).split(path.sep);
    if (name !== "checkout" || !key || !storageKeyPattern.test(key))
      return false;
    // A workload-writable parent could swap the checkout for a symlink.
    const parent = await lstat(path.join(sessions, key)).catch(missingPath);
    return checkoutParentIsProtected(parent);
  }

  async function authorizedDirectory(
    requested: string,
    launch: string,
    managed: boolean,
    owner: string
  ) {
    if (!isCheckoutPath(requested))
      throw new Error("Invalid checkout directory.");
    let dir: string;
    try {
      dir = (await asWorkload("realpath", ["-e", "--", requested])).replace(
        /\n$/,
        ""
      );
      if (!isCheckoutPath(dir)) throw new Error("Invalid checkout directory.");
      await asWorkload("test", ["-d", dir]);
      await asWorkload("test", ["-x", dir]);
    } catch {
      throw new Error(
        "The checkout directory is unavailable to the runner workload."
      );
    }
    // Configured workspaces are allowlisted. Managed sessions may select
    // their owner's checkout, another session's checkout (local allows any
    // directory), or an external root disjoint from runner state.
    const allowed = managed
      ? containsDirectory(path.join(sessions, owner), dir) ||
        (await isSessionCheckout(dir)) ||
        (!containsDirectory(storage, dir) && !containsDirectory(dir, storage))
      : containsDirectory(launch, dir);
    if (!allowed)
      throw new Error("Directory is outside the bound runner checkout.");
    await checkedDirectory(dir);
    return dir;
  }

  async function selectedDirectory(
    key: string,
    workspace: string,
    initial: string
  ) {
    const selected = await readOptional(selectedFile(key));
    if (!selected) return initial;
    return authorizedDirectory(
      selected,
      managedTarget(workspace) ? initial : await configuredDirectory(key),
      managedTarget(workspace),
      checkoutOwner(await readBinding(key)) ?? key
    );
  }

  async function describeCheckout(
    dir: string,
    initial: string
  ): Promise<SessionCheckout> {
    const configured = await asWorkload(
      "git",
      [
        "-C",
        dir,
        "config",
        "--local",
        "--no-includes",
        "--null",
        "--get-all",
        "remote.origin.url",
      ],
      { git: true }
    ).catch(() => "");
    let origin: string | null = null;
    const [url, end, ...extra] = configured.split("\0");
    if (url && end === "" && extra.length === 0) {
      try {
        origin = repositoryUrl(url, true);
      } catch {
        // Only return a recognized, credential-free repository URL.
      }
    }
    // Probe like local, as the workload; icons stay on the runner.
    const git = await probeGitContext(dir, {
      commandRunner: workloadRunner,
      repoIcon: false,
    });
    const context = git.status === "ok" ? git.value : null;
    return {
      path: dir,
      moved: dir !== initial,
      origin,
      repositoryRoot: context?.repoRoot ?? null,
      checkoutRoot: context?.worktreePath ?? null,
      branch: context?.branch || null,
    };
  }

  async function checkoutBorrowers(key: string) {
    const borrowers: string[] = [];
    for (const entry of await readdir(bindings)) {
      if (
        storageKeyPattern.test(entry) &&
        checkoutOwner(await readBinding(entry)) === key
      )
        borrowers.push(entry);
    }
    return borrowers.sort();
  }

  async function describeOwnedState(key: string): Promise<CheckoutState> {
    const dir = await managedDirectory(key);
    if (!config.observeCheckout)
      throw new Error("Checkout observation is unavailable.");
    const scratch = (await readOptional(repositoryFile(key))) === "null";
    return config.observeCheckout(dir, scratch);
  }

  async function observeRelease(
    key: string,
    workspace: string
  ): Promise<CheckoutObservation> {
    const binding = await readBinding(key);
    if (binding === null) {
      if (
        managedTarget(workspace) &&
        ((await lstat(path.join(sessions, key)).catch(missingPath)) ||
          (await readOptional(repositoryFile(key))) !== null)
      )
        throw new Error("The runner session binding is unavailable.");
      return { ownership: "none", owner: null, borrowers: [], checkout: null };
    }
    if (!matchesWorkspace(binding, workspace))
      throw new Error("Agent is not bound to this workspace");
    if (!managedTarget(workspace))
      return {
        ownership: "external",
        owner: null,
        borrowers: [],
        checkout: null,
      };
    const owner = checkoutOwner(binding) ?? key;
    return observeBoundCheckout(
      key,
      owner,
      await checkoutBorrowers(owner),
      await describeOwnedState(owner).catch(() => null)
    );
  }

  async function releaseCheckout(
    key: string,
    workspace: string,
    expectedState: string | null
  ): Promise<CheckoutReleaseResult> {
    const binding = await readBinding(key);
    const receipt = await readOptional(releaseFile(key));
    if (receipt === "retained") return "retained";
    if (binding === null) {
      // Fence a delayed managed launch even if it never registered a binding.
      if (managedTarget(workspace)) {
        if (
          (await lstat(path.join(sessions, key)).catch(missingPath)) ||
          (await readOptional(repositoryFile(key))) !== null
        )
          throw new Error("The runner session binding is unavailable.");
        await writePrivateState(retireFile(key), "");
      }
      return "released";
    }
    if (!matchesWorkspace(binding, workspace))
      throw new Error("Agent is not bound to this workspace");
    const identity = await readIdentity(key);
    if (identity && processes.alive(identity))
      throw new Error("Stop the guest host before releasing it");
    const managed = managedTarget(workspace);
    if (managed) await writePrivateState(retireFile(key), "");
    const dir = path.join(hostRoot, key);
    await cleanHost(key, identity);
    checkUntrackedSocket(dir);
    await cleanLegacyHost(key);
    await removeGuestDirectory(dir);
    if (managed) await rm(path.join(logs, key), { force: true });
    if (binding === managedBinding) {
      const session = path.join(sessions, key);
      // Resume interrupted unregister after the checkout directory was removed.
      const removed =
        receipt === "removing" && !(await lstat(session).catch(missingPath));
      if (!removed) {
        const observed =
          expectedState === null
            ? null
            : await describeOwnedState(key).catch(() => null);
        if (observed?.stateId !== expectedState || expectedState === null) {
          await writePrivateState(releaseFile(key), "retained");
          return "retained";
        }
        if ((await checkoutBorrowers(key)).length > 0) return "inUse";
        await writePrivateState(releaseFile(key), "removing");
      }
      await discardManagedCheckout(key);
    }
    for (const file of [
      cwdFile(key),
      selectedFile(key),
      borrowedFile(key),
      launchFile(key),
      path.join(bindings, key),
    ])
      await rm(file, { force: true });
    await syncBindings();
    return "released";
  }

  async function discardManagedCheckout(key: string) {
    if ((await checkoutBorrowers(key)).length > 0)
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
    const { launchId } = command.launch;
    const recorded =
      launchId === undefined
        ? null
        : parseLaunchRecord(await readOptional(launchFile(key)));
    // Only the same attempt resumes; another ID is a new launch, as before.
    const repeat = recorded?.launchId === launchId ? recorded : null;
    let record: LaunchRecord | null = null;
    const saveLaunch = async (next: LaunchRecord) => {
      record = next;
      await writePrivateState(launchFile(key), JSON.stringify(next));
    };
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
    if (identity && processes.alive(identity)) {
      const live = classifySessionIdentity(identity);
      // This attempt's own host: its reply was lost. Adopt it.
      if (
        repeat &&
        live.kind === "current" &&
        live.record.hostInstanceId === repeat.hostInstanceId
      ) {
        progress?.({ phase: "ready" });
        return;
      }
      throw new Error("Runner already has a host for this agent");
    }
    // A preparation step that ran with no recorded result cannot be
    // reconciled; never run it a second time for the same attempt.
    if (
      repeat?.dependencies === "started" &&
      (await readOptional(dependenciesFile(key))) === null
    )
      throw new Error(UNRECONCILED_DEPENDENCIES);
    // Saved before this launch starts any process.
    if (launchId !== undefined)
      await saveLaunch({
        launchId,
        stage: "preparing",
        ...(repeat?.dependencies && { dependencies: repeat.dependencies }),
      });
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
        const current = record as LaunchRecord | null;
        if (
          command.launch.prepareWorkspace &&
          config.prepareDependencies &&
          (await readOptional(dependenciesFile(key))) === null
        ) {
          if (current?.dependencies === "failed") {
            // This attempt already reported a failed install and went on.
            progress?.({ phase: "dependencies", status: "failed" });
          } else {
            if (current)
              await saveLaunch({ ...current, dependencies: "started" });
            progress?.({ phase: "dependencies" });
            const installed = await config
              .prepareDependencies(cwd)
              .catch(() => false);
            if (installed)
              await writePrivateState(dependenciesFile(key), "done");
            if (current)
              await saveLaunch({
                ...current,
                dependencies: installed ? "done" : "failed",
              });
            progress?.({
              phase: "dependencies",
              status: installed ? "done" : "failed",
            });
          }
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
    cwd = await selectedDirectory(
      key,
      workspace,
      await initialDirectory(key, workspace, managed ? undefined : cwd)
    );
    progress?.({ phase: "ready" });
    const dir = path.join(hostRoot, key);
    const files = path.join(dir, "files");
    const mcpCaPath = hostFile(dir, "serviceMcpCa");
    // The enrollment CA may live under a root-only directory. Publish just
    // the certificate into the private workload state before starting the host.
    const mcpCa = mcp ? await readFile(config.ca) : undefined;
    const {
      repository: _repository,
      useWorktreeOf: _owner,
      prepareWorkspace: _preparation,
      launchId: _launchId,
      ...launchOptions
    } = command.launch;
    const hostIdentity: CurrentSessionIdentity = {
      handoffFormat: runnerHandoff.writes,
      sessionId: agentId,
      hostBuild: config.build,
      hostInstanceId: randomUUID(),
    };
    const launch: HostLaunch = {
      ...launchOptions,
      agentId,
      cwd,
      bins: config.resolveBins
        ? await config.resolveBins(launchOptions.engine)
        : config.bins,
      env: {
        DISPATCH_AGENT_ID: agentId,
        DISPATCH_FILES_DIR: files,
        ...(mcpUrl
          ? {
              DISPATCH_API_URL: mcpUrl.origin,
              DISPATCH_LOCAL_CA_CERTIFICATE: mcpCaPath,
            }
          : { NODE_EXTRA_CA_CERTS: config.ca }),
      },
      pathPrefix: [],
      reportTurnActivity: true,
      hostInstanceId: hostIdentity.hostInstanceId,
    };
    await resetGuestHost(dir, files);
    if (mcpCa) {
      await writeFile(mcpCaPath, mcpCa, { mode: 0o600, flag: "wx" });
      await chown(mcpCaPath, config.uid, config.gid);
    }
    await writeFile(hostFile(dir, "launch"), JSON.stringify(launch), {
      mode: 0o600,
      flag: "wx",
    });
    await chown(hostFile(dir, "launch"), config.uid, config.gid);
    await chown(dir, config.uid, config.gid);

    const reached = record as LaunchRecord | null;
    if (reached)
      await saveLaunch({
        ...reached,
        stage: "spawning",
        hostInstanceId: hostIdentity.hostInstanceId,
      });
    const log = openSync(path.join(logs, key), "a", 0o600);
    try {
      const host = config.hostCommand(dir);
      if (!host[0]) throw new Error("Runner host executable is missing");
      await processes.spawn(
        host,
        cwd,
        mcpCa && env.NODE_EXTRA_CA_CERTS === config.ca
          ? { ...env, NODE_EXTRA_CA_CERTS: undefined }
          : env,
        log,
        (identity) =>
          writePrivateState(
            identityFile(key),
            JSON.stringify({ ...identity, ...hostIdentity })
          ),
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

  async function inspectHost(key: string): Promise<
    | { format: number; host: RetainedHost }
    | null // No live host at this binding.
    | undefined // A possible live host could not be verified.
  > {
    try {
      // Private state is authoritative. In particular, never read identity
      // fields or session IDs back from a workload-writable launch file.
      const handle = await open(
        identityFile(key),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      ).catch(missingPath);
      if (!handle) {
        return hasNamedSocket(path.join(hostRoot, key)) ||
          (await lstat(markerFile(key)).catch(missingPath))
          ? undefined
          : null;
      }
      let identity;
      try {
        const stat = await handle.stat();
        if (
          !stat.isFile() ||
          stat.uid !== process.getuid?.() ||
          stat.mode & 0o077 ||
          stat.size > 4096
        )
          return undefined;
        identity = parseSessionIdentity(await handle.readFile("utf8"));
      } finally {
        await handle.close();
      }
      if (!processes.alive(identity))
        return hasNamedSocket(path.join(hostRoot, key)) ? undefined : null;
      const binding = await readBinding(key);
      if (
        binding === null ||
        !(managedWorkspace
          ? binding === managedBinding || checkoutOwner(binding) !== null
          : config.workspaces.has(binding))
      )
        return undefined;
      const classified = classifySessionIdentity(identity);
      // Legacy format 1 is the shape already used by attach(). It has no
      // known build or stable instance to confirm after a supervisor trial.
      if (classified.kind !== "current") return undefined;
      const { handoffFormat, sessionId, hostBuild, hostInstanceId } =
        classified.record;
      if (runnerStorageKey(sessionId) !== key || hostBuild.revision === null)
        return undefined;
      if (!processes.socketMatchesHost(socketPath(key), identity))
        return undefined;
      return {
        format: handoffFormat,
        host: { sessionId, instanceId: hostInstanceId, build: hostBuild },
      };
    } catch {
      return undefined;
    }
  }

  // Recovered hosts have no ChildProcess exit event. Keep descendant cleanup
  // independent of the service connection and isolate failures by session.
  let sweeping = false;
  const sweep = setInterval(() => {
    // Cleanup runs workload processes; it waits while the update fence holds.
    if (sweeping || config.mayStartProcess?.() === false) return;
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
          if (!(await readOptional(borrowedFile(key)))) {
            const initial = await initialDirectory(author, workspace, cwd);
            await writePrivateState(
              borrowedFile(key),
              await selectedDirectory(author, workspace, initial)
            );
          }
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
        if (
          (await readBinding(key)) === null &&
          !(await readOptional(borrowedFile(key)))
        ) {
          if ((await readBinding(owner)) !== managedBinding)
            throw new Error(
              "The author does not own a checkout on this runner."
            );
          if ((await readOptional(retireFile(owner))) !== null)
            throw new Error("The author checkout has been archived.");
          const initial = await initialDirectory(author, workspace);
          await writePrivateState(
            borrowedFile(key),
            await selectedDirectory(author, workspace, initial)
          );
        }
        return launch(command, cwd, key, owner, progress);
      });
    },
    sessionFile(
      agentId: string,
      workspace: string,
      operation: SessionFileOperation,
      transfer: (
        kind: SessionFileOperation["kind"],
        root: string,
        name: string,
        data?: string
      ) => Promise<string>,
      configuredCwd?: string
    ) {
      const key = runnerStorageKey(agentId);
      return serialize(key, async () => {
        if (
          !isSessionFileOperation(operation) ||
          !(await bound(key, workspace))
        )
          throw new Error("Invalid or unbound session file operation.");
        const files = path.join(hostRoot, key, "files");
        if (operation.kind === "deliver") {
          await transfer("deliver", files, operation.name, operation.data);
          return path.join(files, operation.name);
        }
        const source = path.isAbsolute(operation.path)
          ? path.normalize(operation.path)
          : null;
        if (source && containsDirectory(files, source))
          return transfer("collect", files, path.relative(files, source));
        const checkout = await selectedDirectory(
          key,
          workspace,
          await initialDirectory(key, workspace, configuredCwd)
        );
        const requested = source ?? path.join(checkout, operation.path);
        const owner = checkoutOwner(await readBinding(key)) ?? key;
        if (
          !containsDirectory(checkout, requested) ||
          (containsDirectory(storage, requested) &&
            !containsDirectory(path.join(sessions, owner), requested))
        )
          throw new Error(
            "File path is outside this session's files and checkout."
          );
        return transfer(
          "collect",
          checkout,
          path.relative(checkout, requested)
        );
      });
    },
    async checkoutRelease(
      agentId: string,
      workspace: string,
      operation: CheckoutRelease
    ) {
      const key = runnerStorageKey(agentId);
      const owner = checkoutOwner(await readBinding(key)) ?? key;
      return withLaunchLocks([key, owner], async () => {
        if ((checkoutOwner(await readBinding(key)) ?? key) !== owner)
          throw new Error("The checkout binding changed; retry the request.");
        return operation.kind === "observe"
          ? observeRelease(key, workspace)
          : releaseCheckout(key, workspace, operation.expectedState);
      });
    },
    async withCommandCheckout<T>(
      agentId: string,
      workspace: string,
      checkout: CheckoutCommand["checkout"],
      configuredCwd: string | undefined,
      signal: AbortSignal,
      run: (cwd: string, configuredRoot?: string) => Promise<T>
    ): Promise<T | null> {
      const key = runnerStorageKey(agentId);
      const owner = checkoutOwner(await readBinding(key)) ?? key;
      return withLaunchLocks([key, owner], async () => {
        signal.throwIfAborted();
        if ((checkoutOwner(await readBinding(key)) ?? key) !== owner)
          throw new Error("The checkout binding changed; retry the request.");
        const initial = await initialDirectory(key, workspace, configuredCwd);
        const cwd =
          checkout === "launch"
            ? initial
            : await selectedDirectory(key, workspace, initial);
        signal.throwIfAborted();
        if (checkout === "moved" && cwd === initial) return null;
        const configuredRoot = managedTarget(workspace)
          ? undefined
          : await configuredDirectory(key, configuredCwd);
        return run(cwd, configuredRoot);
      });
    },
    checkoutDirectory(
      agentId: string,
      workspace: string,
      // Only the runner's configured path may supply a missing legacy cwd.
      configuredCwd?: string
    ): Promise<string> {
      const key = runnerStorageKey(agentId);
      return serialize(key, async () =>
        selectedDirectory(
          key,
          workspace,
          await initialDirectory(key, workspace, configuredCwd)
        )
      );
    },
    sessionCheckout(
      agentId: string,
      workspace: string,
      operation: CheckoutOperation,
      configuredCwd?: string
    ): Promise<SessionCheckout> {
      const key = runnerStorageKey(agentId);
      return serialize(key, async () => {
        const initial = await initialDirectory(key, workspace, configuredCwd);
        if (operation.kind === "describe")
          return describeCheckout(
            await selectedDirectory(key, workspace, initial),
            initial
          );
        let dir = initial;
        if (operation.path !== null) {
          const managed = managedTarget(workspace);
          const owner = checkoutOwner(await readBinding(key)) ?? key;
          const launch = managed
            ? initial
            : await configuredDirectory(key, configuredCwd);
          dir = await authorizedDirectory(
            operation.path,
            launch,
            managed,
            owner
          );
          const root = await asWorkload(
            "git",
            ["-C", dir, "rev-parse", "--show-toplevel"],
            { git: true }
          ).catch(() => "");
          if (root)
            dir = await authorizedDirectory(
              root.trimEnd(),
              launch,
              managed,
              owner
            );
        }
        const result = await describeCheckout(dir, initial);
        await writePrivateState(selectedFile(key), result.moved ? dir : "");
        return result;
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

        let fd: number;
        try {
          fd = openHostSocket(socketPath(key), config.uid);
        } catch (error) {
          throw new Error("Guest host socket is unavailable", { cause: error });
        }
        try {
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
        if ((await readOptional(releaseFile(key))) === "retained")
          throw new Error("The checkout was retained.");
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
        await rm(selectedFile(key), { force: true });
        await rm(borrowedFile(key), { force: true });
        await rm(launchFile(key), { force: true });
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
    // A snapshot. The update fence calls it again once admission is closed
    // and admitted work has drained, for the authoritative retained set.
    async inspectHandoff(candidate: HandoffFormats | null) {
      const keys = new Set([
        ...(await trackedKeys()),
        ...(await readdir(hostRoot)).filter((key) =>
          storageKeyPattern.test(key)
        ),
        ...(await readdir(bindings))
          .filter(
            (entry) =>
              entry.endsWith(".owner") &&
              storageKeyPattern.test(entry.slice(0, -6))
          )
          .map((entry) => entry.slice(0, -6)),
      ]);
      const formats: (number | null)[] = [];
      const retained: RetainedHost[] = [];
      for (const key of [...keys].sort()) {
        const inspected = await serialize(key, () => inspectHost(key));
        if (inspected === null) continue;
        formats.push(inspected?.format ?? null);
        if (inspected) retained.push(inspected.host);
      }
      return {
        retained,
        /** Live hosts, verified or not. */
        live: formats.length,
        requiresQuiescence: requiresQuiescence(
          formats,
          runnerHandoff,
          candidate
        ),
      };
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
