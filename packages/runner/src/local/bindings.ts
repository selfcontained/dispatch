/*
 * The runner's own record of which checkout each session is bound to, and
 * whether the runner may remove it. Kept under the state root, one file per
 * session, so it is backed up and fenced with the rest of the state.
 *
 * Bindings for sessions an older build started arrive once over the launcher
 * pipe (`import`). The rules, because a wrong answer here deletes a user's
 * work or orphans a checkout forever:
 *
 * - An existing binding is never replaced: the file is published with
 *   `link`, which fails if the name is taken.
 * - `owned` only when the parent says it created a worktree for the session
 *   AND Git says that exact path is the root of a linked worktree. Anything
 *   else (no claim, a primary checkout, a subdirectory, not Git, a relative
 *   path, Git failing) is `external`: never removed.
 * - A missing directory is `gone`, never owned.
 * - The recorded branch and base are kept as given: a session that switched
 *   branches still names the branch it was created with.
 *
 * A session the runner prepares itself (`workspace.prepare`) is bound by the
 * same decision, once its checkout exists. That binding replaces one the
 * import wrote for the session (an import can run while a launch is
 * preparing) and is never replaced itself.
 *
 * `workspace.select` changes only `currentPath`, the folder the session
 * moved itself into (null: back at its checkout). The checkout, its
 * ownership and the binding's source never change, so a moved-to folder is
 * never owned and never removed.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  launcherBinding,
  type LauncherBinding,
} from "@dispatch/runner-client/launcher";

const run = promisify(execFile);

export type Ownership = "owned" | "external" | "gone";

/** A binding as the runner stores it. */
export type StoredBinding = {
  version: 1;
  session: string;
  path: string;
  currentPath: string | null;
  checkout: {
    path: string;
    ownership: Ownership;
    branch: string | null;
    base: string | null;
    /** Identity evidence survives removal of the session's preparation receipt. */
    identity?: string;
  };
  /** How the runner came to hold it. */
  source: "import" | "prepare";
  /** The session whose current folder this session borrowed. */
  borrowedFrom?: string;
  /**
   * linux-privsep only, until T40: a digest of the supervisor's own binding
   * files as the store last saw them. Never written locally.
   */
  legacy?: string;
};

export type ImportCounts = { added: number; kept: number; invalid: number };

/** The directory under the state root; a dot name no host directory takes. */
export const BINDINGS_DIR = ".bindings";

const fileName = (session: string) =>
  `${createHash("sha256").update(session).digest("hex")}.json`;

const GIT_TIMEOUT_MS = 10_000;

/** The runner's environment without anything that points Git elsewhere. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  for (const name of Object.keys(env))
    if (
      /^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|CEILING_DIRECTORIES)$/.test(
        name
      )
    )
      delete env[name];
  return env;
}

/** Git's output lines in `cwd`, or null when it fails. Never throws. */
export async function git(
  cwd: string,
  args: string[]
): Promise<string[] | null> {
  try {
    const { stdout } = await run("git", ["-C", cwd, ...args], {
      timeout: GIT_TIMEOUT_MS,
      env: gitEnv(),
    });
    return stdout.split("\n").filter(Boolean);
  } catch {
    return null;
  }
}

const real = (path: string) => realpath(path).catch(() => null);

export function directoryIdentity(entry: {
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
}): string {
  return `${entry.dev}:${entry.ino}:${entry.birthtimeNs}`;
}

/** Whether `path` is a directory, something else, or missing (a dangling link included). */
async function presence(
  path: string
): Promise<"directory" | "other" | "missing"> {
  try {
    return (await stat(path)).isDirectory() ? "directory" : "other";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "other";
  }
}

/**
 * True only when Git says `path` is itself the root of a linked worktree:
 * its top level is `path`, and its Git directory is one of the common
 * directory's `worktrees/` entries.
 */
export async function isLinkedWorktreeRoot(path: string): Promise<boolean> {
  const lines = await git(path, [
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--git-dir",
    "--git-common-dir",
  ]);
  if (!lines || lines.length !== 3) return false;
  const [top, gitDir, commonDir] = await Promise.all(lines.map(real));
  const self = await real(path);
  if (!top || !gitDir || !commonDir || !self) return false;
  if (top !== self || gitDir === commonDir) return false;
  return resolve(gitDir, "..") === join(commonDir, "worktrees");
}

/** Decide one imported binding. Never throws: unknown means external. */
export async function decideBinding(
  input: LauncherBinding
): Promise<StoredBinding> {
  const claim = input.worktree;
  const checkoutPath = claim ? claim.path : input.path;
  let ownership: Ownership = "external";
  let identity: string | undefined;
  if (isAbsolute(checkoutPath)) {
    const found = await presence(checkoutPath);
    if (found === "missing") ownership = "gone";
    else if (
      claim &&
      found === "directory" &&
      (await isLinkedWorktreeRoot(checkoutPath))
    ) {
      const entry = await stat(checkoutPath, { bigint: true }).catch(
        () => null
      );
      if (entry?.isDirectory()) {
        ownership = "owned";
        identity = directoryIdentity(entry);
      }
    }
  }
  return {
    version: 1,
    session: input.session,
    path: input.path,
    currentPath: input.currentPath,
    checkout: {
      path: checkoutPath,
      ownership,
      branch: claim?.branch ?? null,
      base: claim?.base ?? null,
      ...(identity === undefined ? {} : { identity }),
    },
    source: "import",
  };
}

/**
 * Where a store keeps its records: one file per session, by name, in one
 * directory. A platform whose state needs its own guards (linux-privsep,
 * as root) supplies its own; locally it is Node's, below.
 */
export interface BindingFiles {
  /** Make the directory when it is missing. */
  prepare(): Promise<void>;
  /** A record's text, or null when it is missing. */
  read(name: string): Promise<string | null>;
  /** Whether anything (even something unreadable) has the name. */
  exists(name: string): Promise<boolean>;
  /** Publish a record under a free name; false when the name is taken. */
  create(name: string, text: string): Promise<boolean>;
  /** Replace a record (or publish it). */
  replace(name: string, text: string): Promise<void>;
  remove(name: string): Promise<void>;
  /** Durable record enumeration where the platform exposes it. */
  list?(): Promise<string[]>;
}

/** The records in `dir` with Node: published with `link`, never replaced by an import. */
export function directoryFiles(dir: string): BindingFiles {
  const temporary = async (text: string) => {
    const temp = join(dir, `.${randomUUID()}.tmp`);
    await writeFile(temp, text, { mode: 0o600 });
    return temp;
  };
  return {
    prepare: () => mkdir(dir, { recursive: true, mode: 0o700 }).then(() => {}),
    async read(name) {
      try {
        return await readFile(join(dir, name), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    list: () =>
      readdir(dir).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }),
    exists: async (name) => (await presence(join(dir, name))) !== "missing",
    async create(name, text) {
      const temp = await temporary(text);
      try {
        await link(temp, join(dir, name));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        return false;
      } finally {
        await rm(temp, { force: true });
      }
    },
    async replace(name, text) {
      const temp = await temporary(text);
      try {
        await rename(temp, join(dir, name));
      } finally {
        await rm(temp, { force: true });
      }
    },
    remove: (name) => rm(join(dir, name), { force: true }),
  };
}

/** A record's file name: the session hashed, so no handle becomes a path. */
export const bindingFileName = fileName;

const encode = (stored: StoredBinding) => JSON.stringify(stored) + "\n";

export class BindingStore {
  readonly dir: string;
  private readonly origins = new Map<string, Promise<string | null>>();
  protected readonly files: BindingFiles;

  constructor(stateRoot: string, files?: BindingFiles) {
    this.dir = join(stateRoot, BINDINGS_DIR);
    this.files = files ?? directoryFiles(this.dir);
  }

  async get(session: string): Promise<StoredBinding | null> {
    const text = await this.files.read(fileName(session));
    if (text === null) return null;
    const stored = JSON.parse(text) as StoredBinding;
    if (!stored || stored.version !== 1 || stored.session !== session)
      throw new Error("Invalid stored checkout binding.");
    return stored;
  }

  /** A completed release/retirement, distinguished from an unknown session. */
  async retire(session: string): Promise<void> {
    await this.files.prepare();
    await this.files.replace(fileName(session) + ".retired", "");
    await this.forget(session);
  }

  isRetired(session: string): Promise<boolean> {
    return this.files.exists(fileName(session) + ".retired");
  }

  /** Bindings that still hold this checkout, including imported legacy sharers. */
  async borrowers(session: string): Promise<string[]> {
    if (!this.files.list) return [];
    const owner = await this.get(session);
    const result: string[] = [];
    for (const name of await this.files.list()) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const text = await this.files.read(name);
      if (text === null) continue;
      const record = JSON.parse(text) as StoredBinding;
      if (!record.session || name !== fileName(record.session))
        throw new Error("Invalid stored checkout binding.");
      if (record.session === session) continue;
      if (
        record.borrowedFrom === session ||
        (owner &&
          record.checkout.path === owner.checkout.path &&
          (record.borrowedFrom || record.checkout.ownership === "external"))
      )
        result.push(record.session);
    }
    return result.sort();
  }

  async forget(session: string): Promise<void> {
    await this.files.remove(fileName(session));
  }

  /**
   * The `origin` remote's URL of the checkout at `path`, or null outside Git
   * or without one. Read once per path: a remote rarely moves, and the
   * answer only describes the binding.
   */
  origin(path: string): Promise<string | null> {
    let origin = this.origins.get(path);
    if (!origin) {
      origin = this.readOrigin(path);
      this.origins.set(path, origin);
    }
    return origin;
  }

  /** The `origin` URL as this platform reads it. */
  protected readOrigin(path: string): Promise<string | null> {
    return git(path, ["config", "--get", "remote.origin.url"]).then(
      (lines) => lines?.[0] ?? null
    );
  }

  /** Replace the session's record with `stored`. */
  protected async put(stored: StoredBinding): Promise<void> {
    await this.files.replace(fileName(stored.session), encode(stored));
  }

  /**
   * Bind a session the runner prepared: the same decision as an import.
   * Replaces an imported binding, never a prepared one, and returns the
   * binding the store holds afterwards.
   */
  async bindPrepared(
    input: LauncherBinding,
    borrowedFrom?: string
  ): Promise<StoredBinding> {
    await this.files.prepare();
    const held = await this.get(input.session);
    if (held?.source === "prepare") return held;
    const stored: StoredBinding = {
      ...(await decideBinding(input)),
      source: "prepare",
      ...(borrowedFrom !== undefined && { borrowedFrom }),
    };
    // An import that published one meanwhile is replaced by this one.
    if (
      held ||
      !(await this.files.create(fileName(input.session), encode(stored)))
    )
      await this.put(stored);
    return stored;
  }

  borrow(
    session: string,
    parent: string,
    path: string
  ): Promise<StoredBinding> {
    return this.bindPrepared(
      { session, path, currentPath: null, worktree: null },
      parent
    );
  }

  /**
   * Record the folder a bound session now works in (null: its checkout),
   * keeping everything else. Returns the binding the store holds
   * afterwards, or null when the session has none.
   */
  async select(
    session: string,
    currentPath: string | null
  ): Promise<StoredBinding | null> {
    const held = await this.get(session);
    if (!held) return null;
    const stored: StoredBinding = { ...held, currentPath };
    await this.put(stored);
    return stored;
  }

  /**
   * Store each binding the runner does not already hold. Malformed entries
   * and empty handles are counted and skipped; a repeated handle keeps the
   * first.
   */
  async import(bindings: unknown[]): Promise<ImportCounts> {
    const counts: ImportCounts = { added: 0, kept: 0, invalid: 0 };
    await this.files.prepare();
    for (const entry of bindings) {
      if (!launcherBinding.check(entry) || !entry.session) {
        counts.invalid += 1;
        continue;
      }
      const name = fileName(entry.session);
      if (await this.files.exists(name)) {
        counts.kept += 1;
        continue;
      }
      const stored = await decideBinding(entry);
      if (await this.files.create(name, encode(stored))) counts.added += 1;
      else counts.kept += 1;
    }
    return counts;
  }
}
