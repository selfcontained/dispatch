import { randomUUID } from "node:crypto";
import {
  mkdir,
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
import { GitWorktreeError } from "../shared/git/worktree.js";
import { AgentError } from "./errors.js";
import { WORKTREE_LOCAL_CONFIG_FILES } from "./worktree-local-config-files.js";
import {
  runnerWorktree,
  type LaunchDirectory,
  type WorktreeRequest,
} from "./workspace-launch.js";

export async function resolveLaunchDirectory(
  rawCwd: string
): Promise<LaunchDirectory> {
  const home = process.env.HOME ?? "/";
  const cwd =
    rawCwd === "~"
      ? home
      : rawCwd.startsWith("~/")
        ? path.join(home, rawCwd.slice(2))
        : rawCwd;
  if (!path.isAbsolute(cwd))
    throw new AgentError("Working directory must be an absolute path.", 400);
  const directory = await stat(cwd).catch(() => null);
  if (!directory?.isDirectory())
    throw new AgentError(
      "Working directory does not exist or is not a directory.",
      400
    );
  const canonicalPath = await realpath(cwd);
  const git = await probeGitContext(canonicalPath, { timeoutMs: 5_000 });
  return { cwd, canonicalPath, git };
}

export type { LaunchDirectory, WorktreeRequest };

/*
 * The preparation receipt in the session's state directory. The runner owns
 * it: it reads and finishes it (`packages/runner/src/core/workspace.ts`).
 * The app writes only the first record, before the agent row exists, so a
 * restart never mistakes the launch for a direct one, and upgrades a receipt
 * an earlier build of this branch wrote (its request in the app's shape).
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

async function directoryIdentity(cwd: string) {
  const evidence = await stat(cwd, { bigint: true });
  return `${evidence.dev}:${evidence.ino}:${evidence.birthtimeNs}`;
}

const legacy = (request: Receipt["request"]): request is WorktreeRequest =>
  "createNewBranch" in request;

export function createWorkspacePreparation() {
  async function bind(
    dir: string,
    directory: LaunchDirectory,
    request: WorktreeRequest
  ) {
    const source = directory.canonicalPath;
    const wanted = runnerWorktree(request);
    const receipt = await readReceipt(dir);
    if (receipt) {
      const recorded = legacy(receipt.request)
        ? runnerWorktree(receipt.request)
        : receipt.request;
      if (
        receipt.source !== source ||
        JSON.stringify(recorded) !== JSON.stringify(wanted)
      )
        throw new GitWorktreeError(
          "This launch already owns a different worktree.",
          409
        );
      return;
    }
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeReceipt(dir, {
      cwd: directory.cwd,
      source,
      sourceIdentity: await directoryIdentity(source),
      request: wanted,
      copy: [...WORKTREE_LOCAL_CONFIG_FILES],
      install: true,
    });
    const parent = await open(path.dirname(dir), "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  }

  return {
    bind,
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
