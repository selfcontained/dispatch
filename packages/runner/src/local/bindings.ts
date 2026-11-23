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
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readFile,
  realpath,
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
  };
  /** How the runner came to hold it. */
  source: "import";
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

async function git(cwd: string, args: string[]): Promise<string[] | null> {
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
  if (isAbsolute(checkoutPath)) {
    const found = await presence(checkoutPath);
    if (found === "missing") ownership = "gone";
    else if (
      claim &&
      found === "directory" &&
      (await isLinkedWorktreeRoot(checkoutPath))
    )
      ownership = "owned";
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
    },
    source: "import",
  };
}

export class BindingStore {
  readonly dir: string;
  private readonly origins = new Map<string, Promise<string | null>>();

  constructor(stateRoot: string) {
    this.dir = join(stateRoot, BINDINGS_DIR);
  }

  async get(session: string): Promise<StoredBinding | null> {
    try {
      return JSON.parse(
        await readFile(join(this.dir, fileName(session)), "utf8")
      ) as StoredBinding;
    } catch {
      return null;
    }
  }

  /**
   * The `origin` remote's URL of the checkout at `path`, or null outside Git
   * or without one. Read once per path: a remote rarely moves, and the
   * answer only describes the binding.
   */
  origin(path: string): Promise<string | null> {
    let origin = this.origins.get(path);
    if (!origin) {
      origin = git(path, ["config", "--get", "remote.origin.url"]).then(
        (lines) => lines?.[0] ?? null
      );
      this.origins.set(path, origin);
    }
    return origin;
  }

  /**
   * Store each binding the runner does not already hold. Malformed entries
   * and empty handles are counted and skipped; a repeated handle keeps the
   * first.
   */
  async import(bindings: unknown[]): Promise<ImportCounts> {
    const counts: ImportCounts = { added: 0, kept: 0, invalid: 0 };
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    for (const entry of bindings) {
      if (!launcherBinding.check(entry) || !entry.session) {
        counts.invalid += 1;
        continue;
      }
      const target = join(this.dir, fileName(entry.session));
      if (await presence(target).then((p) => p !== "missing")) {
        counts.kept += 1;
        continue;
      }
      const stored = await decideBinding(entry);
      const temp = join(this.dir, `.${randomUUID()}.tmp`);
      await writeFile(temp, JSON.stringify(stored) + "\n", { mode: 0o600 });
      try {
        await link(temp, target);
        counts.added += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        counts.kept += 1;
      } finally {
        await rm(temp, { force: true });
      }
    }
    return counts;
  }
}
