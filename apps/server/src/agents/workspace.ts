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
import type { FastifyBaseLogger } from "fastify";

import {
  probeGitContext,
  resolveCurrentBranch,
} from "../shared/git/git-context.js";
import {
  createGitWorktree,
  GitWorktreeError,
  worktreePathSlug,
} from "../shared/git/worktree.js";
import { AgentError } from "./errors.js";
import {
  setupAgentWorkspace,
  type WorkspaceProgress,
} from "./workspace-prep.js";
import { detectDefaultBranch } from "./workspace-target.js";

export async function resolveLaunchDirectory(rawCwd: string) {
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

export type LaunchDirectory = Awaited<
  ReturnType<typeof resolveLaunchDirectory>
>;
export type WorktreeRequest = {
  name: string;
  branch: string;
  baseBranch?: string;
  createNewBranch: boolean;
  location?: "nested" | "sibling";
};
type Progress = (
  step: WorkspaceProgress | { phase: "worktree" | "session" }
) => Promise<void>;
type Receipt = {
  source: string;
  sourceIdentity: string;
  cwd: string;
  request: WorktreeRequest;
  worktree?: {
    path: string;
    branch: string;
    base: string;
    identity: string;
    complete: boolean;
  };
};

async function readReceipt(dir: string): Promise<Receipt | null> {
  try {
    return JSON.parse(
      await readFile(path.join(dir, "workspace-preparation"), "utf8")
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeReceipt(dir: string, receipt: Receipt) {
  const temporary = path.join(dir, `workspace-preparation-${randomUUID()}`);
  try {
    await writeFile(temporary, JSON.stringify(receipt), {
      mode: 0o600,
      flag: "wx",
      flush: true,
    });
    await rename(temporary, path.join(dir, "workspace-preparation"));
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

export function createWorkspacePreparation(logger: FastifyBaseLogger) {
  const pending = new Map<string, Promise<unknown>>();

  async function serialize<T>(
    dir: string,
    action: () => Promise<T>
  ): Promise<T> {
    const current = (pending.get(dir) ?? Promise.resolve())
      .catch(() => {})
      .then(action);
    pending.set(dir, current);
    try {
      return await current;
    } finally {
      if (pending.get(dir) === current) pending.delete(dir);
    }
  }

  async function prepareWorktree(receipt: Receipt, progress: Progress) {
    await progress({ phase: "worktree" });
    const { cwd, request, source } = receipt;
    if (
      (await realpath(cwd).catch(() => null)) !== source ||
      (await directoryIdentity(source).catch(() => null)) !==
        receipt.sourceIdentity
    )
      throw new GitWorktreeError(
        "The launch directory was moved or replaced.",
        409
      );
    const base =
      request.baseBranch ??
      (await detectDefaultBranch(cwd)) ??
      (await resolveCurrentBranch(cwd).catch(() => null)) ??
      "main";
    const branch = request.createNewBranch ? request.branch : base;
    const worktreePath =
      request.location === "nested"
        ? path.join(
            cwd,
            ".dispatch",
            "worktrees",
            worktreePathSlug(branch, request)
          )
        : undefined;
    const result = await createGitWorktree({
      cwd,
      name: request.name,
      branchName: request.createNewBranch ? branch : undefined,
      baseBranch: base,
      worktreePath,
      createNewBranch: request.createNewBranch,
    }).catch((error: unknown) => {
      if (
        error instanceof Error &&
        !(error instanceof GitWorktreeError) &&
        /already (?:checked out|used by worktree)/i.test(error.message)
      )
        throw new GitWorktreeError(
          "The requested branch is already checked out in another worktree.",
          409
        );
      throw error;
    });
    return {
      path: result.worktreePath,
      branch: result.branchName,
      base,
      identity: await directoryIdentity(result.worktreePath),
      complete: false,
    };
  }

  async function finish(dir: string, receipt: Receipt, progress: Progress) {
    const worktree =
      receipt.worktree ?? (await prepareWorktree(receipt, progress));
    if (!receipt.worktree) await writeReceipt(dir, { ...receipt, worktree });
    if (
      (await directoryIdentity(worktree.path).catch(() => null)) !==
      worktree.identity
    )
      throw new GitWorktreeError(
        "The prepared worktree was removed or replaced.",
        409
      );

    if (!worktree.complete) {
      if (
        (await directoryIdentity(receipt.source).catch(() => null)) !==
        receipt.sourceIdentity
      )
        throw new GitWorktreeError(
          "The launch directory was moved or replaced.",
          409
        );
      await setupAgentWorkspace(
        receipt.source,
        worktree.path,
        logger,
        progress
      );
      await writeReceipt(dir, {
        ...receipt,
        worktree: { ...worktree, complete: true },
      });
    }
    await progress({ phase: "session" });
    return {
      effectiveCwd: worktree.path,
      worktreePath: worktree.path,
      worktreeBranch: worktree.branch,
      baseBranch: worktree.base,
      git: await probeGitContext(worktree.path),
    };
  }

  async function bind(
    dir: string,
    directory: LaunchDirectory,
    request: WorktreeRequest
  ) {
    const source = directory.canonicalPath;
    const receipt = await readReceipt(dir);
    if (receipt) {
      if (
        receipt.source !== source ||
        JSON.stringify(receipt.request) !== JSON.stringify(request)
      )
        throw new GitWorktreeError(
          "This launch already owns a different worktree.",
          409
        );
      return receipt;
    }
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const intent = {
      cwd: directory.cwd,
      source,
      sourceIdentity: await directoryIdentity(source),
      request,
    };
    await writeReceipt(dir, intent);
    const parent = await open(path.dirname(dir), "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    return intent;
  }

  return {
    async bind(
      dir: string,
      directory: LaunchDirectory,
      request: WorktreeRequest
    ) {
      await serialize(dir, () => bind(dir, directory, request));
    },
    async prepare(
      dir: string,
      directory: LaunchDirectory,
      request: WorktreeRequest | null,
      progress: Progress
    ) {
      if (!request) {
        await progress({ phase: "session" });
        return {
          effectiveCwd: directory.cwd,
          worktreePath: null,
          worktreeBranch: null,
          baseBranch: null,
          git: directory.git,
        };
      }
      return serialize(dir, async () =>
        finish(dir, await bind(dir, directory, request), progress)
      );
    },
    resume(dir: string, progress: Progress) {
      return serialize(dir, async () => {
        const receipt = await readReceipt(dir);
        return receipt ? finish(dir, receipt, progress) : null;
      });
    },
  };
}
