/* Workspace, path, Git and session-inventory shapes, typed from the local and wire v1 executors. */
import { runnerPath, sessionHandle } from "./opaque.js";
import {
  array,
  boolean,
  integer,
  literal,
  nullable,
  number,
  object,
  optional,
  string,
  union,
} from "./schema.js";
import { build, hostState } from "./types.js";

/** The Git facts of a checkout (local `AgentGitContext`). */
export const gitContext = object({
  repoRoot: runnerPath,
  branch: string,
  worktreePath: runnerPath,
  worktreeName: string,
  isWorktree: boolean,
  repoIconPath: optional(nullable(string)),
  origin: optional(nullable(string)),
});

/** How to check out a repository (wire v1 `RepositoryCheckout`). */
export const repositoryCheckout = union(
  object({ kind: literal("new"), branch: string, base: optional(string) }),
  object({
    kind: literal("branch"),
    branch: string,
    allowDefault: optional(literal(true)),
  }),
  object({ kind: literal("default") }),
  object({ kind: literal("pr"), branch: string, number: integer })
);

/** Where a session's checkout comes from. */
export const workspaceSource = union(
  object({ directory: runnerPath }),
  object({ repository: string, checkout: repositoryCheckout }),
  /** Borrow or make an independent worktree from another session's current folder. */
  object({ session: sessionHandle }),
  object({ scratch: literal(true) })
);

/** An independent worktree of a directory source (local `WorktreeRequest`). */
export const worktreeRequest = object({
  name: string,
  branch: string,
  base: optional(string),
  create: boolean,
  /**
   * Beside the checkout, or in `nested`, a directory relative to the checkout
   * (non-empty, no `..` segment; checked by the runner, as the schema is structural).
   */
  location: optional(union(literal("sibling"), object({ nested: string }))),
});

/** A session's checkout as the runner holds it. */
export const binding = object({
  path: runnerPath,
  moved: boolean,
  origin: nullable(string),
  repositoryRoot: optional(nullable(runnerPath)),
  checkoutRoot: optional(nullable(runnerPath)),
  branch: optional(nullable(string)),
  worktree: optional(
    nullable(
      object({ path: runnerPath, branch: string, base: nullable(string) })
    )
  ),
  git: optional(nullable(gitContext)),
});

export const pathResolution = object({
  resolvedPath: runnerPath,
  canonicalPath: nullable(runnerPath),
  exists: boolean,
  isDirectory: boolean,
  isGitRepo: boolean,
  privacyRestricted: boolean,
  projectRoot: nullable(runnerPath),
  git: nullable(gitContext),
  /** Present when the folder exists but its Git probe failed (`git` is null). */
  gitFailed: optional(literal(true)),
});

export const pathCompletion = object({
  completions: array(string),
  privacyRestricted: optional(boolean),
});

export const branchList = object({
  branches: array(string),
  defaultBranch: optional(string),
});

export const sessionSummary = object({
  session: sessionHandle,
  state: hostState,
  /** Present when the runner can tie the host identity to this launch. */
  launchId: optional(string),
  instanceId: optional(string),
  build: optional(build),
});

/** Process-tree sample of one session's host (local `AgentProcessSnapshot`). */
export const sessionSample = object({
  session: sessionHandle,
  supported: boolean,
  cpuPercent: nullable(number),
  rssBytes: nullable(integer),
  processCount: nullable(integer),
  sampledAt: nullable(integer),
  error: nullable(string),
});
