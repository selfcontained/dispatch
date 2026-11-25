import { randomUUID } from "node:crypto";
import {
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { probeGitContext } from "../shared/git/git-context.js";
import {
  pathFromWire,
  type Req,
  type Res,
} from "@dispatch/runner-protocol/contract";
/** Legacy receipt shape; policy mapping is supplied by the controller. */
export type WorktreeRequest = {
  name: string;
  branch: string;
  baseBranch?: string;
  createNewBranch: boolean;
  location?: "nested" | "sibling";
};
type RunnerWorktree = NonNullable<Req<"workspace.prepare">["worktree"]>;
type OriginReader = (path: string) => Promise<string>;

export type WorkspacePreparationInputs = {
  runnerWorktree(request: WorktreeRequest): RunnerWorktree;
  localConfigFiles: readonly string[];
};

/**
 * What a launch folder is on this machine (`path.resolve`, the local
 * runner's port): `~` expanded from HOME, a relative path left as given,
 * and for a directory its canonical path and main's Git probe. Never
 * throws for the folder itself; the app answers with main's errors.
 */
export async function resolvePath(
  raw: string,
  readOrigin: OriginReader,
  options: Omit<Req<"path.resolve">, "path"> = {},
  /** The platform's project root, including main's native input errors. */
  projectRootOf?: (input: string) => Promise<string>
): Promise<Res<"path.resolve">> {
  const home = process.env.HOME ?? "/";
  const cwd =
    raw === "~"
      ? home
      : raw.startsWith("~/")
        ? path.join(home, raw.slice(2))
        : raw;
  const requestedProjectRoot = (input: string) =>
    options.projectRoot && projectRootOf
      ? projectRootOf(input).then(
          (root) => ({ projectRoot: pathFromWire(root) }),
          (error: unknown) => ({
            projectRootError:
              error instanceof Error ? error.message : String(error),
          })
        )
      : undefined;
  const none = {
    resolvedPath: pathFromWire(cwd),
    canonicalPath: null,
    exists: false,
    isDirectory: false,
    isGitRepo: false,
    privacyRestricted: false,
    projectRoot: null,
    git: null,
  };
  if (!path.isAbsolute(cwd))
    return { ...none, ...(await requestedProjectRoot(cwd)) };
  const found = await stat(cwd).catch(() => null);
  if (!found?.isDirectory())
    return {
      ...none,
      exists: found !== null,
      ...(await requestedProjectRoot(cwd)),
    };
  const canonicalPath = await realpath(cwd);
  // Main's project matching: each root's realpath, a stale one skipped,
  // no Git; and the folder's project root, Git's failure kept as its own.
  const canonical = options.canonical && {
    canonical: await Promise.all(
      options.canonical.map((candidate) =>
        realpath(candidate).then(pathFromWire, () => null)
      )
    ),
  };
  const projectRoot = await requestedProjectRoot(canonicalPath);
  if (options.git === false)
    return {
      ...none,
      canonicalPath: pathFromWire(canonicalPath),
      exists: true,
      isDirectory: true,
      ...projectRoot,
      ...canonical,
    };
  const probed = await probeGitContext(canonicalPath, { timeoutMs: 5_000 });
  const git = probed.status === "ok" ? probed.value : null;
  // A pull request launch names its repository from this origin.
  const origin = git ? await readOrigin(canonicalPath).catch(() => null) : null;
  return {
    ...none,
    canonicalPath: pathFromWire(canonicalPath),
    exists: true,
    isDirectory: true,
    isGitRepo: git !== null,
    git: git && {
      ...git,
      repoRoot: pathFromWire(git.repoRoot),
      worktreePath: pathFromWire(git.worktreePath),
      origin,
    },
    ...(probed.status === "error" && { gitFailed: true as const }),
    ...projectRoot,
    ...canonical,
  };
}

/** The launch folder in process: the same port, answered with main's errors. */
export async function resolveLaunchDirectory<T>(
  rawCwd: string,
  launchDirectory: (resolved: Res<"path.resolve">) => T,
  readOrigin: OriginReader
): Promise<T> {
  return launchDirectory(await resolvePath(rawCwd, readOrigin));
}

/*
 * The preparation receipt in the session's state directory. The runner owns
 * it: it reads and finishes it (`packages/runner/src/core/workspace.ts`).
 * The app writes none: a launch's worktree request is recorded on its row.
 * It upgrades a receipt an earlier build of this branch wrote (its request
 * in the app's shape), and tells whether an earlier build left one.
 */
const RECEIPT_FILE = "workspace-preparation";
type Receipt = {
  source: string;
  sourceIdentity: string;
  cwd: string;
  request: RunnerWorktree | WorktreeRequest;
  copy?: string[];
  install?: boolean;
  [field: string]: unknown;
};

async function readReceipt(dir: string): Promise<Receipt | null> {
  try {
    return JSON.parse(await readFile(path.join(dir, RECEIPT_FILE), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeReceipt(dir: string, receipt: Receipt) {
  const temporary = path.join(dir, `${RECEIPT_FILE}-${randomUUID()}`);
  try {
    await writeFile(temporary, JSON.stringify(receipt), {
      mode: 0o600,
      flag: "wx",
      flush: true,
    });
    await rename(temporary, path.join(dir, RECEIPT_FILE));
    const directory = await open(dir, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

const legacy = (request: Receipt["request"]): request is WorktreeRequest =>
  "createNewBranch" in request;

export function createWorkspacePreparation(inputs: WorkspacePreparationInputs) {
  return {
    /** True once a launch asked for its own worktree in this state dir. */
    async requested(dir: string) {
      return (await readReceipt(dir)) !== null;
    },
    /**
     * Rewrite a receipt an earlier build of this branch wrote into the shape
     * the runner reads, before the runner resumes it. Anything else is left.
     */
    async upgrade(dir: string) {
      const receipt = await readReceipt(dir);
      if (!receipt || !legacy(receipt.request)) return;
      await writeReceipt(dir, {
        ...receipt,
        request: inputs.runnerWorktree(receipt.request),
        copy: receipt.copy ?? [...inputs.localConfigFiles],
        install: receipt.install ?? true,
      });
    },
  };
}
