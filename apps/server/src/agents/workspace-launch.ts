/*
 * A local launch's workspace, prepared by the local runner: the request
 * Dispatch decides (source folder, worktree, copy list, dependencies) goes to
 * `workspace.prepare`, its progress comes back as main's setup phases, and its
 * binding becomes the row's checkout fields. Nothing here touches the
 * machine; the runner creates or reuses the worktree and binds the session.
 *
 * There is no in-process path: a session prepared here is the runner's, and
 * a second owner of one worktree is the failure to avoid. While the runner is
 * unavailable the call waits for it (the session's rule) with no deadline,
 * as main's preparation had none.
 */
import {
  displayPath,
  pathFromWire,
  RunnerCallError,
  sessionFromWire,
  type CallOptions,
  type Event,
  type Res,
  type Runner,
} from "@dispatch/runner-protocol/contract";
import type { AgentGitContext } from "./types.js";
import { WORKTREE_LOCAL_CONFIG_FILES } from "./worktree-local-config-files.js";

/** Main's probe answer for a checkout (`probeGitContext`). */
export type GitProbe =
  | { status: "ok"; value: AgentGitContext | null }
  | { status: "error" };

/** The launch folder the app resolved (`resolveLaunchDirectory`). */
export type LaunchDirectory = {
  cwd: string;
  canonicalPath: string;
  git: GitProbe;
};

/** A launch's own worktree, as Dispatch decided it. */
export type WorktreeRequest = {
  name: string;
  branch: string;
  baseBranch?: string;
  createNewBranch: boolean;
  location?: "nested" | "sibling";
};

/** Where a nested worktree goes, relative to the launch folder. */
export const NESTED_WORKTREES = ".dispatch/worktrees";

/** The launch's worktree as the runner's `workspace.prepare` takes it. */
export function runnerWorktree(request: WorktreeRequest) {
  return {
    name: request.name,
    branch: request.branch,
    ...(request.baseBranch !== undefined && { base: request.baseBranch }),
    create: request.createNewBranch,
    ...(request.location && {
      location:
        request.location === "nested"
          ? { nested: NESTED_WORKTREES }
          : ("sibling" as const),
    }),
  };
}

/** Main's setup steps (`workspace-prep.ts`). */
type WorkspaceProgress = {
  phase: "env" | "deps";
  status?: "done" | "failed";
  detail?: string;
};

export type PrepareProgress = (
  step: WorkspaceProgress | { phase: "worktree" | "session" }
) => Promise<void>;

export type PreparedWorkspace = {
  effectiveCwd: string;
  worktreePath: string | null;
  worktreeBranch: string | null;
  baseBranch: string | null;
  git: GitProbe;
};

type Binding = Res<"workspace.prepare">;

/** The runner's step as main's setup phase. */
function phaseOf(
  event: Event<"workspace.prepare">
): Parameters<PrepareProgress>[0] {
  switch (event.phase) {
    case "workspace":
      return { phase: "worktree" };
    case "copy":
      return { phase: "env" };
    case "dependencies":
      return event.status
        ? { phase: "deps", status: event.status, detail: event.detail }
        : { phase: "deps" };
    case "ready":
      return { phase: "session" };
  }
}

/**
 * Hand progress to `progress` in order, one at a time, as main awaited each
 * step. The runner does not wait for it; a step that fails fails the launch
 * once the runner answers.
 */
function ordered(progress: PrepareProgress) {
  let chain = Promise.resolve();
  let failure: { error: unknown } | null = null;
  return {
    onEvent(event: Event<"workspace.prepare">) {
      chain = chain.then(async () => {
        if (failure) return;
        try {
          await progress(phaseOf(event));
        } catch (error) {
          failure = { error };
        }
      });
    },
    async settled() {
      await chain;
      if (failure) throw failure.error;
    },
  };
}

/**
 * A worktree refusal main answered with its own status (`GitWorktreeError`):
 * its message and status, else null.
 */
export function worktreeRefusal(
  error: unknown
): { message: string; status: number } | null {
  const status = (
    error instanceof RunnerCallError
      ? (error.details as { status?: unknown } | undefined)
      : undefined
  )?.status;
  return typeof status === "number"
    ? { message: (error as Error).message, status }
    : null;
}

function gitOf(binding: Binding): GitProbe {
  if (binding.git === undefined) return { status: "error" };
  if (binding.git === null) return { status: "ok", value: null };
  const { repoRoot, worktreePath, origin: _origin, ...rest } = binding.git;
  return {
    status: "ok",
    value: {
      ...rest,
      repoRoot: displayPath(repoRoot),
      worktreePath: displayPath(worktreePath),
    } as AgentGitContext,
  };
}

function prepared(binding: Binding): PreparedWorkspace {
  const worktree = binding.worktree ?? null;
  return {
    effectiveCwd: displayPath(binding.path),
    worktreePath: worktree ? displayPath(worktree.path) : null,
    worktreeBranch: worktree?.branch ?? null,
    baseBranch: worktree?.base ?? null,
    git: gitOf(binding),
  };
}

function required(runner: Runner | undefined): Runner {
  if (!runner)
    throw new RunnerCallError({
      code: "unavailable",
      message: "The local runner is unavailable",
    });
  return runner;
}

/**
 * Main's deadline for preparation: none. The local runner's session takes a
 * per-call deadline beside the contract's options; null waits without one.
 */
const withoutDeadline = <K extends "workspace.prepare" | "workspace.resume">(
  options: CallOptions<K>
) => ({ ...options, timeoutMs: null }) as CallOptions<K>;

export async function prepareLocalWorkspace(
  runner: Runner | undefined,
  session: string,
  directory: LaunchDirectory,
  worktree: WorktreeRequest | null,
  progress: PrepareProgress
): Promise<PreparedWorkspace> {
  const steps = ordered(progress);
  let binding: Binding;
  try {
    binding = await required(runner).call(
      "workspace.prepare",
      {
        session: sessionFromWire(session),
        source: { directory: pathFromWire(directory.cwd) },
        ...(worktree && { worktree: runnerWorktree(worktree) }),
        copyIgnored: [...WORKTREE_LOCAL_CONFIG_FILES],
        installDependencies: true,
      },
      withoutDeadline<"workspace.prepare">({ onEvent: steps.onEvent })
    );
  } catch (error) {
    await steps.settled().catch(() => {});
    throw error;
  }
  await steps.settled();
  const result = prepared(binding);
  // A folder launch keeps main's probe of the folder it resolved.
  return worktree ? result : { ...result, git: directory.git };
}

/** Finish a launch a restart interrupted; null when it never asked for a worktree. */
export async function resumeLocalWorkspace(
  runner: Runner | undefined,
  session: string,
  progress: PrepareProgress
): Promise<PreparedWorkspace | null> {
  const steps = ordered(progress);
  let binding: Res<"workspace.resume">;
  try {
    binding = await required(runner).call(
      "workspace.resume",
      { session: sessionFromWire(session) },
      withoutDeadline<"workspace.resume">({ onEvent: steps.onEvent })
    );
  } catch (error) {
    await steps.settled().catch(() => {});
    throw error;
  }
  await steps.settled();
  return binding ? prepared(binding) : null;
}
