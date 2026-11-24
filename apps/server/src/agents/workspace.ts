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
import { inferRepositoryUrl } from "./remote/repository.js";
import { pathFromWire, type Res } from "@dispatch/runner-protocol/contract";
import { WORKTREE_LOCAL_CONFIG_FILES } from "./worktree-local-config-files.js";
import {
  launchDirectory,
  runnerWorktree,
  type LaunchDirectory,
  type WorktreeRequest,
} from "./workspace-launch.js";

/**
 * What a launch folder is on this machine (`path.resolve`, the local
 * runner's port): `~` expanded from HOME, a relative path left as given,
 * and for a directory its canonical path and main's Git probe. Never
 * throws for the folder itself; the app answers with main's errors.
 */
export async function resolvePath(raw: string): Promise<Res<"path.resolve">> {
  const home = process.env.HOME ?? "/";
  const cwd =
    raw === "~"
      ? home
      : raw.startsWith("~/")
        ? path.join(home, raw.slice(2))
        : raw;
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
  if (!path.isAbsolute(cwd)) return none;
  const found = await stat(cwd).catch(() => null);
  if (!found?.isDirectory()) return { ...none, exists: found !== null };
  const canonicalPath = await realpath(cwd);
  const probed = await probeGitContext(canonicalPath, { timeoutMs: 5_000 });
  const git = probed.status === "ok" ? probed.value : null;
  // A pull request launch names its repository from this origin.
  const origin = git
    ? await inferRepositoryUrl(canonicalPath).catch(() => null)
    : null;
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
  };
}

/** The launch folder in process: the same port, answered with main's errors. */
export async function resolveLaunchDirectory(
  rawCwd: string
): Promise<LaunchDirectory> {
  return launchDirectory(await resolvePath(rawCwd));
}

export type { LaunchDirectory, WorktreeRequest };

/*
 * The preparation receipt in the session's state directory. The runner owns
 * it: it reads and finishes it (`packages/runner/src/core/workspace.ts`).
 * The app writes none: a launch's worktree request is recorded on its row.
 * It upgrades a receipt an earlier build of this branch wrote (its request
 * in the app's shape), and tells whether an earlier build left one.
 */
const RECEIPT_FILE = "workspace-preparation";
type RunnerWorktree = ReturnType<typeof runnerWorktree>;
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

export function createWorkspacePreparation() {
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
        request: runnerWorktree(receipt.request),
        copy: receipt.copy ?? [...WORKTREE_LOCAL_CONFIG_FILES],
        install: receipt.install ?? true,
      });
    },
  };
}
