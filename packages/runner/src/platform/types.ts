/*
 * The platform port: what the runner core asks of the machine it runs on.
 * One core, two platforms (`posix-user`, `linux-privsep`). `workload` and
 * `workspace` exist so far; process, layout and private-state parts arrive
 * with the families that need them.
 */
import type { Req, Res } from "@dispatch/runner-protocol/contract";

/**
 * Checkout reads a platform runs as the workload account. On `posix-user`
 * that is a direct function call in the runner's own process; on
 * `linux-privsep` it is one self-exec of the worker entry under the
 * workload's identity. They write nothing, so a frozen runner serves them.
 */
export const WORKER_OPS = [
  "checkout.list",
  "checkout.preview",
  "checkout.index",
  "checkout.read",
  "checkout.stats",
  "checkout.diff",
  "checkout.changes",
  "checkout.image",
  "checkout.defaultFiles",
  "git.context",
  "git.defaultBranch",
] as const;

/** Commands the workload runs. They may write, so the fence refuses them. */
export const EXEC_OPS = ["checkout.exec"] as const;

export type WorkerOp = (typeof WORKER_OPS)[number];
export type ExecOp = (typeof EXEC_OPS)[number];
export type WorkloadOp = WorkerOp | ExecOp;

/** Which of a session's checkouts a target selected. */
export type Selector = "current" | "launch" | "moved";

/**
 * A workload operation's input: the request without its target, and the
 * directory the core resolved the target to. The workload never sees a
 * session handle, and the core never touches the directory itself. A
 * command also gets the selector, since a command in the current checkout
 * runs at that checkout's root and one in a named checkout runs in it.
 */
export type WorkerInput<K extends WorkloadOp> = {
  directory: string;
  request: Omit<Req<K>, "target">;
} & (K extends ExecOp ? { selector: Selector } : unknown) &
  (K extends "git.context" ? { checkoutBranch?: string } : unknown);

export type RunOptions = { signal?: AbortSignal };

export interface Workload {
  run<K extends WorkloadOp>(
    op: K,
    input: WorkerInput<K>,
    options: RunOptions
  ): Promise<Res<K>>;
  /**
   * Watch a checkout as the workload account (`checkout.watch`): `changed`
   * once per burst of changes, `closed` when the watch ends by itself.
   * Returns the stop. Without it, `checkout.watch` is unsupported.
   */
  watch?(
    directory: string,
    changed: () => void,
    closed: () => void
  ): () => void;
}

export interface Platform {
  workload: Workload;
  /** Preparing checkouts from a directory; without it, `workspace.prepare` is unsupported. */
  workspace?: WorkspacePort;
  /** The workload account's GitHub reads; without it, `github.*` is unsupported. */
  github?: GitHubPort;
  /** The workload account's engines; without it, `engine.list` and sign-in are unsupported. */
  engines?: EnginePort;
}

/**
 * The engine CLIs as the workload account has them: which are installed,
 * and their sign-in. A sign-in runs the CLI's own login as that account, so
 * it lands in the configuration its agents read.
 */
export interface EnginePort {
  /** Every engine with its installation, sign-in and actions (`engine.list`). */
  list(request: Req<"engine.list">): Promise<Res<"engine.list">>;
  /**
   * Start a sign-in, or join the one under way (`engine.login.start`).
   * `onUpdate` hears of the login as soon as it exists, before its link.
   */
  loginStart(
    request: Req<"engine.login.start">,
    onUpdate: (login: Res<"engine.login.start">) => void
  ): Promise<Res<"engine.login.start">>;
  loginSubmit(
    request: Req<"engine.login.submit">
  ): Promise<Res<"engine.login.submit">>;
  loginStatus(
    request: Req<"engine.login.status">
  ): Promise<Res<"engine.login.status">>;
  loginCancel(
    request: Req<"engine.login.cancel">
  ): Promise<Res<"engine.login.cancel">>;
  /** Stop every sign-in under way; the runner is shutting down. */
  close(): void;
}

/**
 * GitHub reads as the workload account, with its own credentials. They
 * write nothing, so a frozen runner serves them.
 */
export interface GitHubPort {
  /** A pull request's state and current checks (`github.pr.status`). */
  pullRequestStatus(
    request: Req<"github.pr.status">,
    options: RunOptions
  ): Promise<Res<"github.pr.status">>;
  /** A pull request's evidence: description, size and files (`github.pr.details`). */
  pullRequestDetails(
    request: Req<"github.pr.details">,
    options: RunOptions
  ): Promise<Res<"github.pr.details">>;
  /** Changed files with patches between two commits (`github.pr.diff`). */
  pullRequestDiff(
    request: Req<"github.pr.diff">,
    options: RunOptions
  ): Promise<Res<"github.pr.diff">>;
}

/** A checkout's Git facts, paths as text (the contract's `gitContext`). */
export type CheckoutGit = {
  repoRoot: string;
  branch: string;
  worktreePath: string;
  worktreeName: string;
  isWorktree: boolean;
  repoIconPath?: string | null;
  origin?: string | null;
};

/** An independent worktree of a directory, as the core resolved it. */
export type WorktreeSpec = {
  /** The directory the worktree is made from, as given. */
  directory: string;
  name: string;
  /** The branch to create, or the base to check out when not creating. */
  branch: string;
  base: string;
  create: boolean;
  /** A directory relative to `directory` to hold it; beside it when absent. */
  nested?: string;
  /**
   * The exact path the platform chose for it (`RepositoryPort.location`),
   * an empty directory it made; when present, `nested` and the sibling
   * layout do not apply.
   */
  at?: string;
  /** The directory source may have refs without an origin. */
  fromDirectory?: true;
};

/**
 * Preparing a checkout from a directory, as the workload account. The core
 * decides what happens and in which order, records it, and binds the
 * session; the platform does each step on the machine.
 */
export interface WorkspacePort {
  /** Carry out an authorized release of the bound checkout. */
  release?(
    session: string,
    checkout: { path: string; identity?: string },
    request: Pick<Req<"workspace.release">, "deleteBranch" | "originalBranch">
  ): Promise<boolean>;
  /**
   * The state of a bound checkout an archive decides on: its branch, Git's
   * outstanding work against its base, and a fingerprint of all of it.
   * Throws when it cannot be read.
   */
  observe?(path: string): Promise<{
    path: string;
    branch: string | null;
    stateId: string;
    unmerged: boolean;
    changedFiles: string[];
    uncommittedFiles: string[];
  }>;
  /** The canonical path of an existing directory, else null. */
  canonical(path: string): Promise<string | null>;
  /**
   * What is at `path` for the workload account: a directory (with its
   * canonical path), something else, or nothing it can reach.
   */
  locate(
    path: string
  ): Promise<{ directory: string } | "not_directory" | "missing">;
  /** Evidence that a directory is the same one later (device, inode, birth), else null. */
  identity(path: string): Promise<string | null>;
  /**
   * Where `create` will put the worktree and which branch it checks out,
   * with the same validation and errors, writing nothing. `taken` when
   * something is already at the path, so `create` will refuse it.
   */
  plan(
    spec: WorktreeSpec
  ): Promise<{ path: string; branch: string; taken: boolean }>;
  /** Make the worktree at the planned path. */
  create(
    spec: WorktreeSpec,
    path: string
  ): Promise<{ path: string; branch: string }>;
  /** Copy the named ignored files from `source` that `destination` lacks; returns those copied. */
  copyIgnored(
    source: string,
    destination: string,
    names: readonly string[]
  ): Promise<string[]>;
  /** Install dependencies, reporting the outcome; a failure is reported, not thrown. */
  installDependencies(
    directory: string,
    report: (step: {
      status: "done" | "failed";
      detail: string;
    }) => Promise<void>
  ): Promise<void>;
  /** The checkout's Git facts: null outside Git, "error" when the probe failed. */
  git(directory: string): Promise<CheckoutGit | null | "error">;
  /**
   * Whether `path` is the root of a linked worktree of `source`'s
   * repository with `branch` checked out. A platform whose runner is not
   * the workload account answers this as the workload; without it the core
   * asks Git itself.
   */
  madeForUs?(path: string, source: string, branch: string): Promise<boolean>;
  /** Cached clones of repositories; without it, a repository source is unsupported. */
  repository?: RepositoryPort;
}

/**
 * One cached clone per repository, as the workload account with its own Git
 * configuration, transports, credentials and hooks; tags are fetched. The
 * core serialises the calls for one cache directory.
 */
export interface RepositoryPort {
  /**
   * Clone `url` into `clone` (inside `cache`, which may not exist yet), or
   * reuse the clone there and fetch from `url`. The clone has no checked-out
   * branch, so every branch can be a worktree. Returns the remote's default
   * branch, or null when it has none.
   */
  cache(
    url: string,
    cache: string,
    clone: string
  ): Promise<{ defaultBranch: string | null }>;
  /** Fetch pull request `number`'s head into local branch `branch` of the clone, unless it already has diverged work. */
  pullRequest(clone: string, number: number, branch: string): Promise<void>;
  /**
   * Where the session's checkout goes: the platform creates (or repairs)
   * what holds it and returns an empty directory the workload owns, the
   * same path every time for one session. Without it the checkout goes
   * beside the clone, and the core makes nothing outside its own state.
   */
  location?(session: string): Promise<string>;
  /** Remove what `location` made for the session, checkout first. */
  remove?(session: string): Promise<void>;
}
