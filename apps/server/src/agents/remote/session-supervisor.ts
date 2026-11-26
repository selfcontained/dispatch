import type { CheckoutCommand } from "@dispatch/runner-protocol";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, type Stats } from "node:fs";
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
import type { Socket } from "node:net";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { BuildIdentity } from "@dispatch/runner-protocol/build-identity";
import {
  agentLaunchBindings,
  prepareHostLaunch,
  writeHostLaunch,
} from "@dispatch/runner/host/host-env";
import {
  HOST_FILES,
  hostFile,
  type HostLaunch,
} from "@dispatch/runner-client/host-framing";
import {
  displayPath,
  RunnerCallError,
  sessionFromWire,
  sessionToWire,
  type SessionHandle,
  type Req,
  type Res,
  pathFromWire,
} from "@dispatch/runner-protocol/contract";
import { probeGitContext } from "../../shared/git/git-context.js";
import type { CommandRunner } from "../../shared/lib/run-command.js";
import {
  MANAGED_WORKSPACE,
  UNOBSERVED_STATE,
  isOpaqueId,
  isCheckoutPath,
  isSessionFileOperation,
  type SessionFileOperation,
  type SessionCheckout,
  type CheckoutObservation,
  observeBoundCheckout,
  parseRepository,
  repositoryUrl,
  type CheckoutRelease,
  type CheckoutReleaseResult,
  type CheckoutState,
  type SessionOperation,
  type Command,
  type LaunchProgress,
  type RunnerRepository,
  type RunnerEngine,
} from "@dispatch/runner-protocol";
import { sizedName } from "./session-files.js";
import {
  classifySessionIdentity,
  createSessionProcesses,
  openHostSocket,
  parseSessionIdentity,
  type RecordedSessionIdentity,
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

const retainedHostFiles = new Set<string>([
  HOST_FILES.journal,
  HOST_FILES.journalId,
  HOST_FILES.receipts,
]);

type LaunchCommand = Extract<Command, { kind: "launch" }> & {
  launch: { useWorktreeOf?: unknown };
};

type CheckoutOperation = Extract<
  SessionOperation,
  { kind: "sessionCheckout" }
>["operation"];
type ContextOperation = Extract<CheckoutOperation, { kind: "context" }>;

/** One launch attempt's durable identity, kept by the session core. */
type LaunchRecord = {
  launchId: string;
  stage: "preparing" | "spawning";
  owner?: string;
  hostInstanceId?: string;
  dependencies?: "started" | "done" | "failed";
};

/** A file the core reads from private state for verification. */
type PrivateRecord = {
  trusted(): Promise<boolean>;
  read(): Promise<string>;
  close(): Promise<void>;
};

/**
 * The runner's session core (`@dispatch/runner`'s `createSessionCore`),
 * injected by the `remote-runner` entry. It owns host records, the session
 * lock, spawn, attach, alive, stop and logs; bindings and checkouts stay here.
 */
export type SessionCoreFactory = (options: {
  processes: {
    alive(identity: RecordedSessionIdentity): boolean;
    spawn(
      command: string[],
      cwd: string,
      env: NodeJS.ProcessEnv,
      log: number,
      record: (identity: RecordedSessionIdentity) => Promise<void>,
      onExit: (identity: RecordedSessionIdentity) => void
    ): Promise<void>;
    stop(identity: RecordedSessionIdentity, force: boolean): Promise<void>;
    cleanup(identity: RecordedSessionIdentity): Promise<void>;
    cleanupLegacy(marker: string): Promise<void>;
    socketMatchesHost(
      socket: string,
      identity: RecordedSessionIdentity
    ): boolean;
    socketInUse(socket: string): boolean;
    pinSocket(socket: string): { address: string; release(): void };
    parseIdentity(raw: string): RecordedSessionIdentity;
  };
  layout: {
    hostDir(key: string): string;
    socket(key: string): string;
    sockets(key: string): string[];
    identityFile(key: string): string;
    markerFile(key: string): string;
    launchFile(key: string): string;
    logFile(key: string): string;
    trackedKeys(): Promise<string[]>;
  };
  state: {
    read(file: string): Promise<string | null>;
    write(file: string, contents: string): Promise<void>;
    remove(file: string): Promise<void>;
    exists(file: string): Promise<boolean>;
    openPrivate(file: string): Promise<PrivateRecord | null>;
  };
  mayRun?: () => boolean;
}) => {
  lock<T>(key: string, operation: () => Promise<T>): Promise<T>;
  locks<T>(keys: string[], operation: () => Promise<T>): Promise<T>;
  readIdentity(key: string): Promise<RecordedSessionIdentity | null>;
  readLaunch(key: string): Promise<LaunchRecord | null>;
  saveLaunch(key: string, record: LaunchRecord): Promise<void>;
  removeLaunch(key: string): Promise<void>;
  alive(key: string): Promise<boolean>;
  isAlive(identity: RecordedSessionIdentity): boolean;
  clean(key: string, identity: RecordedSessionIdentity | null): Promise<void>;
  cleanLegacy(key: string): Promise<void>;
  checkUntrackedSocket(key: string): void;
  spawn(
    key: string,
    hostCommand: () => string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    extra: Record<string, unknown>
  ): Promise<void>;
  attach(key: string): Promise<Socket | null>;
  stop(key: string, force: boolean): Promise<void>;
  logs(key: string): Promise<{ live: boolean; text: string }>;
  removeLog(key: string): Promise<void>;
  trackedKeys(): Promise<string[]>;
  sample(
    roots: ReadonlyMap<SessionHandle, number>
  ): Promise<Res<"session.sample">["samples"]>;
  inspect(
    key: string,
    verify: (identity: RecordedSessionIdentity) => Promise<boolean>
  ): Promise<RecordedSessionIdentity | null | undefined>;
  close(): void;
};

type SupervisorOptions = {
  build: BuildIdentity;
  /** The session core, injected by the runner entry. */
  sessions: SessionCoreFactory;
  state: string;
  streamHelper: string;
  uid: number;
  gid: number;
  ca: string;
  bins: HostLaunch["bins"];
  resolveBins?: (engine: RunnerEngine) => Promise<HostLaunch["bins"]>;
  env: NodeJS.ProcessEnv;
  workspaces: ReadonlySet<string>;
  /**
   * The host command for state `dir`. It must enter `cwd` itself, after
   * privilege is dropped: the launcher starts in `/` and never changes into
   * a workload path as root.
   */
  hostCommand: (dir: string, cwd: string) => string[];
  asWorkload: WorkloadCommand;
  probeCheckoutGit?: (cwd: string) => Promise<Res<"git.context">>;
  githubCredentialHelper?: () => Promise<string>;
  observeCheckout?: (
    cwd: string,
    scratch: boolean,
    policyOnly?: boolean
  ) => Promise<CheckoutState>;
  prepareDependencies?: (cwd: string) => Promise<boolean>;
  resumePreparedCheckout?: (
    agentId: string
  ) => Promise<Res<"workspace.resume">>;
  removePreparedCheckout?: (session: string) => Promise<boolean>;
  /**
   * The runner core's binding store, told after this supervisor changed a
   * session's binding files, so it records them. Absent where the runner
   * keeps no core store (configured workspaces).
   */
  bindingWritten?: (agentId: string) => Promise<void>;
  /** False while the update fence holds process admission closed. */
  mayStartProcess?: () => boolean;
};

export const UNRECONCILED_DEPENDENCIES =
  "The runner restarted while preparing dependencies for this launch, so " +
  "their result is unknown. They were not run again. Start the agent to retry.";

const managedBinding = "\0managed";
const sharedBindingPrefix = managedBinding + ":";
/**
 * A folder the agent named (D7), prepared by the core with no worktree: its
 * `.cwd` holds the path the workload resolved. Never the runner's to remove.
 */
const folderBinding = "\0folder";
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

/** A binding in the managed workspace: owned, borrowed or a named folder. */
function managedKind(binding: string | null) {
  return (
    binding === managedBinding ||
    binding === folderBinding ||
    checkoutOwner(binding) !== null
  );
}

function containsDirectory(root: string, dir: string) {
  return dir === root || dir.startsWith(root === "/" ? root : root + "/");
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
  const helperBin = path.join(storage, "bin");
  try {
    for (const [root, mode] of [
      [logs, 0o700],
      [hostRoot, 0o711],
      [sessions, checkoutAncestorMode],
      [cache, 0o711],
      [helperBin, 0o755],
    ] as const) {
      await mkdir(root, { mode, recursive: true });
      await ownedDirectory(
        root,
        mode,
        root === sessions ? config.gid : undefined
      );
    }
    const streamHelper = path.join(helperBin, "dispatch-stream");
    await writePrivateState(streamHelper, config.streamHelper, 0o755);
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

  async function writePrivateState(
    file: string,
    contents: string,
    mode = 0o600
  ) {
    const temp = path.join(bindings, `.pending-${randomUUID()}`);
    try {
      const handle = await open(temp, "wx", 0o600);
      try {
        await handle.writeFile(contents);
        if (mode !== 0o600) await handle.chmod(mode);
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

  /**
   * After a session's binding files changed: the core's store records them.
   * Never fails the caller; the store's next read reconciles the files.
   */
  async function recordBinding(agentId: string) {
    try {
      await config.bindingWritten?.(agentId);
    } catch {
      // The files are today's record until T40; the store catches up on read.
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
  const borrowedFromFile = (key: string) =>
    path.join(bindings, `${key}.borrowed-from`);
  const markerFile = (key: string) => path.join(bindings, `${key}.owner`);
  const identityFile = (key: string) => path.join(bindings, `${key}.host`);
  const launchFile = (key: string) => path.join(bindings, `${key}.launch`);
  const socketPath = (key: string) =>
    hostFile(path.join(hostRoot, key), "socket");
  const core = config.sessions({
    processes: {
      alive: (identity) => processes.alive(identity),
      spawn: (...args) => processes.spawn(...args),
      stop: (identity, force) => processes.stop(identity, force),
      cleanup: (identity) => processes.cleanup(identity),
      cleanupLegacy: (marker) => processes.cleanupLegacy(marker),
      socketMatchesHost: (socket, identity) =>
        processes.socketMatchesHost(socket, identity),
      socketInUse: (socket) => processes.socketInUse(socket),
      pinSocket(socket) {
        const fd = openHostSocket(socket, config.uid);
        return {
          address: `/proc/self/fd/${fd}`,
          release: () => closeSync(fd),
        };
      },
      parseIdentity: parseSessionIdentity,
    },
    layout: {
      hostDir: (key) => path.join(hostRoot, key),
      socket: socketPath,
      sockets(key) {
        const dir = path.join(hostRoot, key);
        const originalPath = path.join(config.state, "hosts", key);
        return originalPath === dir
          ? [hostFile(dir, "socket")]
          : [hostFile(dir, "socket"), hostFile(originalPath, "socket")];
      },
      identityFile,
      markerFile,
      launchFile,
      logFile: (key) => path.join(logs, key),
      trackedKeys,
    },
    state: {
      read: readOptional,
      write: writePrivateState,
      remove: (file) => rm(file, { force: true }),
      exists: async (file) => !!(await lstat(file).catch(missingPath)),
      async openPrivate(file) {
        const handle = await open(
          file,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        ).catch(missingPath);
        if (!handle) return null;
        return {
          async trusted() {
            const stat = await handle.stat();
            return (
              stat.isFile() &&
              stat.uid === process.getuid?.() &&
              !(stat.mode & 0o077) &&
              stat.size <= 4096
            );
          },
          read: () => handle.readFile("utf8"),
          close: () => handle.close(),
        };
      },
    },
    mayRun: config.mayStartProcess,
  });
  const serialize = core.lock;
  const withLaunchLocks = core.locks;
  function managedTarget(workspace: string) {
    if (managedWorkspace && workspace === MANAGED_WORKSPACE) return true;
    if (!config.workspaces.has(workspace))
      throw new Error("Unknown runner workspace");
    return false;
  }

  const readIdentity = (key: string) => core.readIdentity(key);
  const cleanHost = core.clean;
  const cleanLegacyHost = core.cleanLegacy;
  const checkUntrackedSocket = core.checkUntrackedSocket;

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

  function canRetain(entry: Stats | null) {
    return (
      entry?.isFile() &&
      entry.uid === config.uid &&
      entry.gid === config.gid &&
      entry.nlink === 1
    );
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
      const journal = await lstat(hostFile(dir, "journal")).catch(missingPath);
      const retainJournal = canRetain(journal);
      for (const name of Object.values(HOST_FILES)) {
        const file = path.join(dir, name);
        if (
          retainJournal &&
          retainedHostFiles.has(name) &&
          canRetain(await lstat(file).catch(missingPath))
        )
          continue;
        await unlink(file).catch(missingPath);
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
    const launch =
      managed && binding === folderBinding
        ? await namedFolder(key)
        : managed
          ? await managedDirectory(owner ?? key)
          : await configuredDirectory(key, configuredCwd);
    const borrowed = await readOptional(borrowedFile(key));
    return borrowed && borrowed !== launch
      ? authorizedDirectory(borrowed)
      : launch;
  }

  /**
   * A folder the session selected (or a borrower inherited): any directory
   * the workload account can use, as on the controller (T16). The runner
   * checks it as that account and records the resolved path.
   */
  async function authorizedDirectory(requested: string) {
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
    await checkedDirectory(dir);
    return dir;
  }

  /**
   * A named folder, resolved again as the workload: it must still be the
   * directory the workload resolved when it was bound, or nothing starts.
   */
  async function namedFolder(key: string) {
    const bound = await readOptional(cwdFile(key));
    if (!bound) throw new Error("The named folder is unavailable.");
    if ((await authorizedDirectory(bound)) !== bound)
      throw new Error("The named folder changed since it was resolved.");
    return bound;
  }

  async function selectedDirectory(
    key: string,
    workspace: string,
    initial: string
  ) {
    const selected = await readOptional(selectedFile(key));
    if (!selected) return initial;
    return authorizedDirectory(selected);
  }

  async function checkoutGitContext(dir: string): Promise<Res<"git.context">> {
    if (config.probeCheckoutGit) return config.probeCheckoutGit(dir);
    const git = await probeGitContext(dir, { commandRunner: workloadRunner });
    if (git.status === "error") throw new Error("Git context probe failed.");
    if (!git.value) return null;
    return {
      ...git.value,
      repoRoot: pathFromWire(git.value.repoRoot),
      worktreePath: pathFromWire(git.value.worktreePath),
    };
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
    const context = await checkoutGitContext(dir).catch(() => null);
    return {
      path: dir,
      moved: dir !== initial,
      origin,
      repositoryRoot: context ? displayPath(context.repoRoot) : null,
      checkoutRoot: context ? displayPath(context.worktreePath) : null,
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

  async function describeOwnedState(
    key: string,
    policyOnly?: boolean
  ): Promise<CheckoutState> {
    const dir = await managedDirectory(key);
    if (!config.observeCheckout)
      throw new Error("Checkout observation is unavailable.");
    const scratch = (await readOptional(repositoryFile(key))) === "null";
    return config.observeCheckout(dir, scratch, policyOnly);
  }

  async function observeRelease(
    key: string,
    workspace: string,
    policy?: "ownership" | "changes"
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
    if (!managedTarget(workspace) || binding === folderBinding)
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
      policy === "ownership"
        ? null
        : await describeOwnedState(owner, policy === "changes").catch(
            () => null
          )
    );
  }

  async function releaseCheckout(
    key: string,
    agentId: string,
    workspace: string,
    expectedState: string | null
  ): Promise<CheckoutReleaseResult> {
    // Only v1 peers using checkoutRelease use snapshot and borrower checks.
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
    if (identity && core.isAlive(identity))
      throw new Error("Stop the guest host before releasing it");
    const managed = managedTarget(workspace);
    if (managed) await writePrivateState(retireFile(key), "");
    const dir = path.join(hostRoot, key);
    await cleanHost(key, identity);
    checkUntrackedSocket(key);
    await cleanLegacyHost(key);
    await removeGuestDirectory(dir);
    if (managed) await core.removeLog(key);
    if (binding === managedBinding) {
      const session = path.join(sessions, key);
      // Resume interrupted unregister after the checkout directory was removed.
      const removed =
        receipt === "removing" && !(await lstat(session).catch(missingPath));
      if (!removed) {
        const observed =
          expectedState === null || expectedState === UNOBSERVED_STATE
            ? null
            : await describeOwnedState(key).catch(() => null);
        if (observed?.stateId !== expectedState || expectedState === null) {
          await writePrivateState(releaseFile(key), "retained");
          return "retained";
        }
        if ((await checkoutBorrowers(key)).length > 0) return "inUse";
        await writePrivateState(releaseFile(key), "removing");
      }
      await discardManagedCheckout(key, agentId);
    }
    for (const file of [
      cwdFile(key),
      selectedFile(key),
      borrowedFile(key),
      borrowedFromFile(key),
      launchFile(key),
      path.join(bindings, key),
    ])
      await rm(file, { force: true });
    await syncBindings();
    await recordBinding(agentId);
    return "released";
  }

  async function discardManagedCheckout(key: string, agentId: string) {
    if ((await checkoutBorrowers(key)).length > 0)
      throw new Error("Runner checkout is still in use by a borrower.");
    if (!(await config.removePreparedCheckout?.(agentId))) {
      const session = path.join(sessions, key);
      const stored = await readOptional(repositoryFile(key));
      const repository =
        stored === null
          ? null
          : (JSON.parse(stored) as RunnerRepository | null);
      // Remove the directory before unregistering it so the workload never
      // regains write access to a protected checkout parent.
      if (
        repository &&
        checkoutParentIsProtected(await lstat(session).catch(missingPath))
      )
        await removeGuestDirectory(path.join(session, "checkout"));
      await removeGuestDirectory(session);
      if (repository) await repositories.remove(session, repository);
    }
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
    // A named folder is bound only by the core's preparation, never here.
    const folder = managed && !owner && binding === folderBinding;
    const bindingValue = owner
      ? sharedBindingPrefix + owner
      : folder
        ? folderBinding
        : managed
          ? managedBinding
          : workspace;
    if (binding !== null && binding !== bindingValue)
      throw new Error("Agent is not bound to this workspace or checkout");
    // Core-prepared sessions launch from their receipt under the same session lock.
    const prepared =
      managed && !owner && !folder
        ? await config.resumePreparedCheckout?.(agentId)
        : null;
    if (
      prepared &&
      ((await readBinding(key)) !== managedBinding ||
        !prepared.checkoutRoot ||
        displayPath(prepared.checkoutRoot) !== (await managedDirectory(key)))
    )
      throw new Error("The prepared checkout binding changed.");
    const { launchId, owner: sessionOwner } = command.launch;
    const recorded = launchId === undefined ? null : await core.readLaunch(key);
    // Only the same attempt resumes; another ID is a new launch, as before.
    const repeat =
      recorded?.launchId === launchId &&
      (recorded?.owner === undefined || recorded.owner === sessionOwner)
        ? recorded
        : null;
    let record: LaunchRecord | null = null;
    const saveLaunch = async (next: LaunchRecord) => {
      record =
        sessionOwner === undefined ? next : { ...next, owner: sessionOwner };
      await core.saveLaunch(key, record);
    };
    progress?.({ phase: "workspace" });
    if (owner) {
      if ((await readBinding(owner)) !== managedBinding)
        throw new Error("The author does not own a checkout on this runner.");
      if (binding === null && (await readOptional(retireFile(owner))) !== null)
        throw new Error("The author checkout has been archived.");
      cwd = await managedDirectory(owner);
    }
    if (binding === null) {
      await writePrivateState(path.join(bindings, key), bindingValue);
      await recordBinding(agentId);
    }
    const identity = await readIdentity(key);
    if (identity && core.isAlive(identity)) {
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
    checkUntrackedSocket(key);
    await cleanLegacyHost(key);
    if (folder) {
      // Resolved again as the workload; a folder that moved fails the launch.
      cwd = await namedFolder(key);
    } else if (prepared) {
      cwd = displayPath(prepared.path);
    } else if (managed && !owner) {
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
      if (stored === null) {
        await writePrivateState(repositoryFile(key), encoded);
        await recordBinding(agentId);
      }
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
      await recordBinding(agentId);
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
      owner: _sessionOwner,
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
    await resetGuestHost(dir, files);
    const launch = await prepareHostLaunch(
      dir,
      {
        ...launchOptions,
        agentId,
        cwd,
        bins: config.resolveBins
          ? await config.resolveBins(launchOptions.engine)
          : config.bins,
        reportTurnActivity: true,
        hostInstanceId: hostIdentity.hostInstanceId,
      },
      {
        filesDir: files,
        helperBin,
        home: env.HOME,
        mcpOrigin: mcpUrl?.origin,
        mcpCaFile: mcpCaPath,
        env: {
          ...agentLaunchBindings(launchOptions.engine),
          ...(mcpUrl
            ? {
                DISPATCH_API_URL: { from: "mcp.origin" },
                DISPATCH_API_BASE: { from: "mcp.origin" },
                DISPATCH_PORT: mcpUrl.port || "443",
                DISPATCH_SCHEME: "https",
                DISPATCH_LOCAL_CA_CERTIFICATE: { from: "mcp.caFile" },
              }
            : { NODE_EXTRA_CA_CERTS: config.ca }),
        },
      }
    );
    if (
      launchOptions.personaContext &&
      launch.personaContext !== launchOptions.personaContext
    )
      await chown(
        hostFile(dir, "personaContext"),
        config.uid,
        config.gid
      ).catch(missingPath);
    if (mcpCa) {
      await writeFile(mcpCaPath, mcpCa, { mode: 0o600, flag: "wx" });
      await chown(mcpCaPath, config.uid, config.gid);
    }
    await writeHostLaunch(dir, launch, "wx");
    await chown(hostFile(dir, "launch"), config.uid, config.gid);
    await chown(dir, config.uid, config.gid);

    const reached = record as LaunchRecord | null;
    if (reached)
      await saveLaunch({
        ...reached,
        stage: "spawning",
        hostInstanceId: hostIdentity.hostInstanceId,
      });
    await core.spawn(
      key,
      () => config.hostCommand(dir, cwd),
      "/",
      mcpCa && env.NODE_EXTRA_CA_CERTS === config.ca
        ? { ...env, NODE_EXTRA_CA_CERTS: undefined }
        : env,
      hostIdentity
    );
  }

  async function bound(key: string, workspace: string) {
    return matchesWorkspace(await readBinding(key), workspace);
  }

  function matchesWorkspace(binding: string | null, workspace: string) {
    return managedTarget(workspace)
      ? managedKind(binding)
      : binding === workspace;
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
    let current: CurrentSessionIdentity | undefined;
    const identity = await core.inspect(key, async (identity) => {
      const binding = await readBinding(key);
      if (
        binding === null ||
        !(managedWorkspace
          ? managedKind(binding)
          : config.workspaces.has(binding))
      )
        return false;
      const classified = classifySessionIdentity(identity);
      // Legacy format 1 is the shape already used by attach(). It has no
      // known build or stable instance to confirm after a supervisor trial.
      if (classified.kind !== "current") return false;
      if (
        runnerStorageKey(classified.record.sessionId) !== key ||
        classified.record.hostBuild.revision === null
      )
        return false;
      current = classified.record;
      return true;
    });
    if (!identity) return identity;
    const { handoffFormat, sessionId, hostBuild, hostInstanceId } = current!;
    return {
      format: handoffFormat,
      host: { sessionId, instanceId: hostInstanceId, build: hostBuild },
    };
  }

  return {
    stateDirectory: storage,
    async withWorkspacePreparation<T>(
      agentId: string,
      preparing: boolean,
      run: (
        readLegacy: (
          request?: Req<"workspace.prepare">
        ) => Promise<Res<"workspace.resume">>
      ) => Promise<T>,
      parentId?: string
    ): Promise<T | null> {
      const key = runnerStorageKey(agentId);
      const parent =
        parentId === undefined ? undefined : runnerStorageKey(parentId);
      if (parent === key)
        throw new RunnerCallError({
          code: "invalid",
          message: "A session cannot borrow itself.",
        });
      const owner =
        parent === undefined
          ? undefined
          : (checkoutOwner(await readBinding(parent)) ?? parent);
      const perform = async () => {
        if ((await readOptional(retireFile(key))) !== null) {
          if (!preparing) return null;
          throw new RunnerCallError({
            code: "conflict",
            message: "This runner session was discarded.",
          });
        }
        if (
          parent !== undefined &&
          owner !== undefined &&
          !(await readBinding(key)) &&
          ((checkoutOwner(await readBinding(parent)) ?? parent) !== owner ||
            (await readOptional(retireFile(parent))) !== null ||
            (await readOptional(retireFile(owner))) !== null)
        )
          throw new RunnerCallError({
            code: "conflict",
            message: "The author checkout has been archived or changed.",
          });
        return run(async (request) => {
          const encoded = await readOptional(repositoryFile(key));
          const stored =
            encoded === null
              ? null
              : (JSON.parse(encoded) as RunnerRepository | null);
          if (request) {
            const source = request.source;
            let matches = false;
            if ("repository" in source && stored) {
              try {
                const requested = parseRepository({
                  url: source.repository,
                  checkout: source.checkout,
                });
                matches =
                  requested.url === stored.url &&
                  isDeepStrictEqual(
                    requested.checkout,
                    parseRepository(stored).checkout
                  );
              } catch {
                // The legacy record only accepts its existing HTTPS repository.
              }
            }
            if (!matches)
              throw new RunnerCallError({
                code: "conflict",
                message:
                  "This runner session is bound to a different checkout.",
              });
          }
          if (
            !(await bound(key, MANAGED_WORKSPACE)) ||
            (await readOptional(planFile(key))) !== null
          )
            throw new RunnerCallError({
              code: "conflict",
              message:
                "Continue this legacy preparation by retrying its original launch.",
            });
          const initial = await initialDirectory(key, MANAGED_WORKSPACE);
          const current = await selectedDirectory(
            key,
            MANAGED_WORKSPACE,
            initial
          );
          const description = await describeCheckout(current, initial);
          return {
            ...description,
            path: pathFromWire(description.path),
            repositoryRoot: description.repositoryRoot
              ? pathFromWire(description.repositoryRoot)
              : null,
            checkoutRoot: pathFromWire(initial),
          };
        });
      };
      return parent === undefined || owner === undefined
        ? serialize(key, perform)
        : withLaunchLocks([...new Set([key, parent, owner])], perform);
    },
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
            await recordBinding(command.agentId);
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
      // Prepared from a folder session: the child holds that folder as its
      // own external binding, so it starts there with no owner to borrow.
      if ((await readBinding(key)) === folderBinding)
        return serialize(key, () => launch(command, cwd, key, null, progress));
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
          await recordBinding(command.agentId);
        }
        return launch(command, cwd, key, owner, progress);
      });
    },
    sessionFile(
      agentId: string,
      workspace: string,
      operation: SessionFileOperation,
      transfer: (
        kind: "deliver" | "receive" | "collect" | "stream",
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
          if (operation.streamId === undefined)
            await transfer("deliver", files, operation.name, operation.data);
          else
            await transfer(
              "receive",
              files,
              sizedName(operation.name, operation.size)
            );
          return path.join(files, operation.name);
        }
        const kind = operation.streamId === undefined ? "collect" : "stream";
        if (path.isAbsolute(operation.path))
          return transfer(kind, "", operation.path);
        const checkout = await selectedDirectory(
          key,
          workspace,
          await initialDirectory(key, workspace, configuredCwd)
        );
        return transfer(kind, checkout, operation.path);
      });
    },
    async releaseWorkspace(
      agentId: string,
      workspace: string,
      release: (legacySource: string | null) => Promise<boolean>
    ): Promise<boolean> {
      const key = runnerStorageKey(agentId);
      return serialize(key, async () => {
        const binding = await readBinding(key);
        if (binding === null) {
          if (managedTarget(workspace))
            await writePrivateState(retireFile(key), "");
          return true;
        }
        if (!matchesWorkspace(binding, workspace))
          throw new Error("Agent is not bound to this workspace");
        if (!managedTarget(workspace) || binding !== managedBinding)
          return false;
        const identity = await readIdentity(key);
        if (identity && core.isAlive(identity))
          throw new Error("Stop the guest host before releasing it");
        checkUntrackedSocket(key);
        const retiring = (await readOptional(retireFile(key))) !== null;
        const stored = await readOptional(repositoryFile(key));
        if (
          stored === null &&
          (!retiring ||
            (await lstat(path.join(sessions, key)).catch(missingPath)))
        )
          throw new Error("The runner checkout repository is unavailable.");
        await writePrivateState(retireFile(key), "");
        const repository =
          stored === null
            ? null
            : (JSON.parse(stored) as RunnerRepository | null);
        // A worktree the core prepared from a session or a folder records
        // `{}`: no repository cache to hold, only the checkout to release.
        const removed =
          stored === null ||
          (repository?.url
            ? await repositories.inCache(repository.url, release)
            : await release(null));
        if (!removed) return false;
        await cleanHost(key, identity);
        await cleanLegacyHost(key);
        await removeGuestDirectory(path.join(hostRoot, key));
        await core.removeLog(key);
        for (const file of [
          repositoryFile(key),
          planFile(key),
          dependenciesFile(key),
          cwdFile(key),
          selectedFile(key),
          borrowedFile(key),
          borrowedFromFile(key),
          launchFile(key),
          path.join(bindings, key),
        ])
          await rm(file, { force: true });
        await syncBindings();
        await recordBinding(agentId);
        return true;
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
          ? observeRelease(key, workspace, operation.policy)
          : releaseCheckout(key, agentId, workspace, operation.expectedState);
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
      configuredCwd?: string,
      checkout: "current" | "launch" = "current"
    ): Promise<string> {
      if (checkout !== "current" && checkout !== "launch")
        return Promise.reject(new Error("Invalid checkout read selector."));
      const key = runnerStorageKey(agentId);
      return serialize(key, async () => {
        const initial = await initialDirectory(key, workspace, configuredCwd);
        return checkout === "launch"
          ? initial
          : selectedDirectory(key, workspace, initial);
      });
    },
    gitContext(
      agentId: string,
      workspace: string,
      operation: ContextOperation,
      configuredCwd?: string
    ): Promise<Res<"git.context">> {
      const key = runnerStorageKey(agentId);
      return serialize(key, async () => {
        const initial = await initialDirectory(key, workspace, configuredCwd);
        if (operation.checkout === "launch") return checkoutGitContext(initial);
        const selected = await selectedDirectory(key, workspace, initial);
        if (operation.checkout === "moved" && selected === initial)
          throw new Error("The moved checkout is no longer selected.");
        return checkoutGitContext(selected);
      });
    },
    sessionCheckout(
      agentId: string,
      workspace: string,
      operation: Exclude<CheckoutOperation, ContextOperation>,
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
          dir = await authorizedDirectory(operation.path);
          const root = await asWorkload(
            "git",
            ["-C", dir, "rev-parse", "--show-toplevel"],
            { git: true }
          ).catch(() => "");
          if (root) dir = await authorizedDirectory(root.trimEnd());
        }
        const result = await describeCheckout(dir, initial);
        await writePrivateState(selectedFile(key), result.moved ? dir : "");
        await recordBinding(agentId);
        return result;
      });
    },
    async listSessions(
      workspace: string,
      owner: string | null = null
    ): Promise<Res<"session.list">> {
      const sessions = await Promise.all(
        (await core.trackedKeys()).map((key) =>
          serialize(key, async () => {
            if (!(await bound(key, workspace))) return null;
            const identity = await readIdentity(key);
            if (!identity) return null;
            const classified = classifySessionIdentity(identity);
            const agentId =
              classified.kind === "current"
                ? classified.record.sessionId
                : identity.sessionId;
            if (!agentId || runnerStorageKey(agentId) !== key) return null;
            const launch = await core.readLaunch(key);
            if (owner !== null && launch?.owner !== owner) return null;
            return {
              session: sessionFromWire(agentId),
              state: core.isAlive(identity)
                ? ("live" as const)
                : ("gone" as const),
              ...(classified.kind === "current" && {
                instanceId: classified.record.hostInstanceId,
                build: {
                  version: classified.record.hostBuild.version,
                  ...(classified.record.hostBuild.revision !== null && {
                    revision: classified.record.hostBuild.revision,
                  }),
                },
              }),
              ...(classified.kind === "current" &&
                launch?.stage === "spawning" &&
                launch.hostInstanceId === classified.record.hostInstanceId && {
                  launchId: launch.launchId,
                }),
            };
          })
        )
      );
      return { sessions: sessions.filter((session) => session !== null) };
    },
    async sampleSessions(
      workspace: string,
      sessions: SessionHandle[]
    ): Promise<Res<"session.sample">> {
      const roots = new Map<SessionHandle, number>();
      await Promise.all(
        [...new Set(sessions)].map(async (session) => {
          const key = runnerStorageKey(sessionToWire(session));
          await serialize(key, async () => {
            if (!(await bound(key, workspace))) return;
            const identity = await readIdentity(key);
            if (identity && core.isAlive(identity))
              roots.set(session, identity.pid);
          });
        })
      );
      return { samples: await core.sample(roots) };
    },
    async alive(agentId: string, workspace: string) {
      const key = runnerStorageKey(agentId);
      return serialize(key, async () => {
        if (!(await bound(key, workspace))) return false;
        return core.alive(key);
      });
    },
    attach(agentId: string, workspace: string) {
      const key = runnerStorageKey(agentId);
      return serialize(key, async () => {
        if (!(await bound(key, workspace)))
          throw new Error("Agent is not bound to this workspace");
        return core.attach(key);
      });
    },
    stop(
      agentId: string,
      workspace: string,
      force: boolean,
      expectedLaunchId?: string,
      expectedOwner?: string
    ) {
      const key = runnerStorageKey(agentId);
      return serialize(key, async () => {
        if (expectedOwner !== undefined && expectedLaunchId === undefined)
          return false;
        if (expectedLaunchId !== undefined) {
          const launch = await core.readLaunch(key);
          if (launch?.launchId !== expectedLaunchId) return false;
          const identity = await readIdentity(key);
          if (
            expectedOwner !== undefined &&
            (launch.owner !== expectedOwner ||
              launch.stage !== "spawning" ||
              launch.hostInstanceId === undefined ||
              !identity)
          )
            return false;
          if (identity && launch.hostInstanceId !== identity.hostInstanceId)
            return false;
        }
        if (!(await bound(key, workspace))) {
          if (expectedLaunchId !== undefined) return false;
          if (managedTarget(workspace) && (await readBinding(key)) === null)
            return;
          throw new Error("Agent is not bound to this workspace");
        }
        await core.stop(key, force);
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
            await config.removePreparedCheckout?.(agentId);
            return;
          }
          throw new Error("Agent is not bound to this workspace");
        }
        const identity = await readIdentity(key);
        if (identity && core.isAlive(identity))
          throw new Error("Stop the guest host before discarding it");
        if (managed) await writePrivateState(retireFile(key), "");
        const dir = path.join(hostRoot, key);
        await cleanHost(key, identity);
        checkUntrackedSocket(key);
        await cleanLegacyHost(key);
        if (managed) {
          if (!checkoutOwner(await readBinding(key)))
            await discardManagedCheckout(key, agentId);
          await core.removeLog(key);
        } else {
          await rm(cwdFile(key), { force: true });
        }
        await removeGuestDirectory(dir);
        await rm(selectedFile(key), { force: true });
        await rm(borrowedFile(key), { force: true });
        await rm(borrowedFromFile(key), { force: true });
        await core.removeLaunch(key);
        await rm(path.join(bindings, key), { force: true });
        if (managed) await syncBindings();
        await recordBinding(agentId);
      });
    },
    async log(agentId: string, workspace: string) {
      const key = runnerStorageKey(agentId);
      if (!(await bound(key, workspace)))
        throw new Error("Agent is not bound to this workspace");
      const { live, text: log } = await core.logs(key);
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
              ? managedKind(binding)
              : config.workspaces.has(binding))
          )
            return null;
          const identity = await readIdentity(key);
          return identity && core.isAlive(identity)
            ? path.join(hostRoot, key)
            : null;
        })
      );
      return dirs.filter((dir) => dir !== null);
    },
    close() {
      core.close();
      release();
    },
  };
}
