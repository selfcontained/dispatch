import { createHash } from "node:crypto";
import { chown, lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import type { RunnerRepository } from "./protocol.js";
import { validBranch } from "./repository.js";
import { githubCredentialKey } from "./workload-tools.js";

/** The supervisor-owned parent prevents workloads from replacing session roots. */
export async function prepareScratchSession(
  sessions: string,
  key: string,
  uid: number,
  gid: number
): Promise<string> {
  const cwd = path.join(sessions, key);
  await mkdir(cwd, { mode: 0o700, recursive: true });
  await chown(cwd, uid, gid);
  return cwd;
}

/** Executes on the runner as the verified workload identity. */
export type WorkloadCommand = (
  executable: string,
  args: string[],
  options?: { git?: boolean }
) => Promise<string>;

function worktreePaths(list: string): string[] {
  return list
    .split("\0")
    .flatMap((line) =>
      line.startsWith("worktree ") ? [line.slice("worktree ".length)] : []
    );
}

type CheckoutPlan = {
  /** The runner's resolved branch for an implicit default checkout. */
  branch?: string;
  commit: string;
  fastForward: boolean;
  reviewBase?: string;
  trackRemote: boolean;
};

type CheckoutJournal = {
  read: () => Promise<CheckoutPlan | null>;
  write: (plan: CheckoutPlan) => Promise<void>;
  clear: () => Promise<void>;
};

// Serialize provisioning and removal for each shared bare repository.
export class RunnerRepositories {
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(
    private readonly cacheRoot: string,
    private readonly uid: number,
    private readonly gid: number,
    private readonly execute: WorkloadCommand,
    private readonly githubCredentialHelper?: () => Promise<string>
  ) {}

  private async inCache<T>(
    url: string,
    operation: (dir: string) => Promise<T>
  ): Promise<T> {
    const key = createHash("sha256").update(url).digest("hex");
    const dir = path.join(this.cacheRoot, key);
    const previous = this.pending.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(() => operation(dir));
    this.pending.set(key, current);
    try {
      return await current;
    } finally {
      if (this.pending.get(key) === current) this.pending.delete(key);
    }
  }

  private git(...args: string[]): Promise<string> {
    return this.execute("git", args, { git: true });
  }

  async prepare(
    session: string,
    repository: RunnerRepository,
    journal: CheckoutJournal
  ): Promise<string> {
    const { url, checkout } = repository;
    const cwd = path.join(session, "checkout");
    return this.inCache(url, async (cache) => {
      await prepareScratchSession(
        this.cacheRoot,
        path.basename(cache),
        this.uid,
        this.gid
      );
      const git = (...args: string[]) =>
        this.git(`--git-dir=${cache}`, ...args);
      await this.git("init", "--quiet", "--bare", "--template=", cache);
      // The bare repository config is shared by its managed worktrees. Leave
      // the workload user's global configuration and helper chain intact.
      if (this.githubCredentialHelper)
        await git(
          "config",
          "--local",
          "--replace-all",
          githubCredentialKey,
          await this.githubCredentialHelper()
        );
      const pendingPlan = await journal.read();
      const requestedBranch =
        checkout.kind === "default" ? pendingPlan?.branch : checkout.branch;
      const finish = async (branch: string, plan: CheckoutPlan) => {
        try {
          if (plan.fastForward)
            await this.git("-C", cwd, "merge", "--ff-only", "--", plan.commit);
          if (plan.reviewBase)
            await git(
              "config",
              "--replace-all",
              `branch.${branch}.dispatchReviewBase`,
              plan.reviewBase
            );
          if (plan.trackRemote)
            await git(
              "branch",
              `--set-upstream-to=refs/remotes/origin/${branch}`,
              "--",
              branch
            );
        } catch (error) {
          // Keep the worktree reserved. A repeat launch can finish this plan
          // without deleting the checkout or mistaking its branch for someone else's.
          throw new Error("Could not update the runner session branch.", {
            cause: error,
          });
        }
        await journal.clear();
      };
      const worktrees = worktreePaths(
        await git("worktree", "list", "--porcelain", "-z")
      );
      if (worktrees.includes(cwd)) {
        if (
          (
            await this.git("-C", cwd, "rev-parse", "--show-toplevel")
          ).trimEnd() !== cwd
        )
          throw new Error("The runner session checkout is unavailable.");
        if (pendingPlan) {
          const current = await this.git(
            "-C",
            cwd,
            "symbolic-ref",
            "--short",
            "HEAD"
          );
          if (current.trim() !== requestedBranch || !requestedBranch)
            throw new Error(
              "The runner session checkout changed during preparation."
            );
          await finish(requestedBranch, pendingPlan);
        }
        return cwd;
      }

      const readDefaultBranch = async () => {
        const defaultRef = await git(
          "ls-remote",
          "--symref",
          "--",
          url,
          "HEAD"
        ).catch(() => {
          throw new Error(
            "Could not read the remote repository's default branch."
          );
        });
        return /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(defaultRef)?.[1];
      };
      // A retry after reservation or a busy branch keeps the original choice
      // even when the remote's HEAD starts pointing to a different branch.
      const defaultBranch =
        checkout.kind === "default" && requestedBranch
          ? requestedBranch
          : await readDefaultBranch();
      if (!validBranch(defaultBranch))
        throw new Error(
          "The remote repository has no unambiguous default branch."
        );
      const branch = requestedBranch ?? defaultBranch;
      if (
        branch === defaultBranch &&
        checkout.kind !== "default" &&
        !(checkout.kind === "branch" && checkout.allowDefault)
      )
        throw new Error(
          "The default branch cannot be used as a session branch."
        );

      await git("config", "--replace-all", "remote.origin.url", url);
      await git(
        "config",
        "--replace-all",
        "remote.origin.fetch",
        "+refs/heads/*:refs/remotes/origin/*"
      );
      await git(
        "fetch",
        "--prune",
        "--no-tags",
        "--no-recurse-submodules",
        "--",
        url,
        "+refs/heads/*:refs/remotes/origin/*"
      ).catch(() => {
        throw new Error("Could not fetch the runner repository.");
      });

      const refCommit = async (ref: string) => {
        const output = await git(
          "for-each-ref",
          "--format=%(refname) %(objectname)",
          ref
        );
        return output
          .split("\n")
          .find((line) => line.startsWith(ref + " "))
          ?.slice(ref.length + 1);
      };
      const local = await refCommit(`refs/heads/${branch}`);
      const remote = await refCommit(`refs/remotes/origin/${branch}`);
      let commit: string | undefined;
      switch (checkout.kind) {
        case "new":
          if (local || remote)
            throw new Error("The new session branch already exists.");
          commit = await refCommit(
            `refs/remotes/origin/${checkout.base ?? defaultBranch}`
          );
          break;
        case "branch":
        case "default":
          commit = remote;
          break;
        case "pr":
          await git(
            "fetch",
            "--no-tags",
            "--no-recurse-submodules",
            "--",
            url,
            `refs/pull/${checkout.number}/head`
          ).catch(() => {
            throw new Error("Could not fetch the pull request head.");
          });
          commit = (
            await git("rev-parse", "--verify", "FETCH_HEAD^{commit}")
          ).trim();
          if (remote && remote !== commit)
            throw new Error(
              "The named branch does not match the pull request head."
            );
          break;
      }
      if (!commit)
        throw new Error("The requested checkout branch was not found.");
      const needsFastForward = Boolean(local && local !== commit);
      if (needsFastForward) {
        await git("merge-base", "--is-ancestor", local!, commit).catch(() => {
          throw new Error(
            "The runner branch has local work; choose another branch."
          );
        });
      }

      // Git rejects a branch already held by another worktree. Only update
      // the branch after Git has reserved it for this checkout.
      const args = local
        ? ["--", cwd, branch]
        : ["--no-track", "-b", branch, "--", cwd, commit];
      const plan: CheckoutPlan = {
        ...(checkout.kind === "default" && { branch }),
        commit,
        fastForward: needsFastForward,
        reviewBase:
          checkout.kind === "new"
            ? (checkout.base ?? defaultBranch)
            : undefined,
        trackRemote: checkout.kind !== "new" && Boolean(remote),
      };
      await journal.write(plan);
      await git("worktree", "add", ...args).catch(() => {
        throw new Error(
          "Could not create the session checkout. The branch may already be occupied."
        );
      });
      await finish(branch, plan);
      return cwd;
    });
  }

  async remove(session: string, repository: RunnerRepository): Promise<void> {
    const cwd = path.join(session, "checkout");
    return this.inCache(repository.url, async (cache) => {
      // Provisioning may have failed before git init.
      if (!(await lstat(path.join(cache, "HEAD")).catch(missingPath))) return;
      const git = (...args: string[]) =>
        this.git(`--git-dir=${cache}`, ...args);
      const worktrees = worktreePaths(
        await git("worktree", "list", "--porcelain", "-z")
      );
      if (worktrees.includes(cwd))
        await git("worktree", "remove", "--force", "--", cwd);
    });
  }
}

export function missingPath(error: NodeJS.ErrnoException): null {
  if (error.code !== "ENOENT") throw error;
  return null;
}
