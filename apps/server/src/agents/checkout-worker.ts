import { json } from "node:stream/consumers";
import {
  isCheckoutReadRequest,
  type CheckoutReadName,
} from "@dispatch/runner-protocol";
/*
 * The checkout worker: the workload side of checkout reads and commands, as
 * one entry.
 *
 * - `checkoutWorkload` is the `posix-user` platform's workload for these
 *   operations: a direct call, in the local runner child's own process.
 * - `workspaceWorkload` is that platform's `workspace` port: each step of
 *   preparing a checkout from a directory, which the runner core orders,
 *   records and binds.
 *   `main.ts` hands it to the runner (`@dispatch/runner/cli`), which types
 *   it structurally; nothing here imports the runner.
 * - `runCheckoutWorker` is the self-exec entry (`runner-worker <op>`) the
 *   Linux runner starts under the workload account.
 *
 * This is runner code that has not moved to `packages/runner` yet; it runs
 * only inside a runner process, never in the app.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  RunnerCallError,
  pathFromWire,
  operations,
  type DeclarableError,
  type ErrorCode,
  type Req,
  type Res,
} from "@dispatch/runner-protocol/contract";
import { readWorkspaceView, WorkspaceError } from "../files/workspace-view.js";
import { getAgentDiff, getAgentFileDiff } from "../shared/git/agent-diff.js";
import { getDiffStatsComputation } from "../shared/git/diff-stats.js";
import { inspectCheckout } from "./checkout-inspection.js";
import { spawn } from "node:child_process";
import { loginShellCommand } from "./acp/host-command.js";
import { readCheckoutCommandFile } from "./checkout-inspection.js";
import {
  capture,
  commandBaseEnvironment,
} from "./checkout-command-executor.js";
import {
  access,
  lstat,
  mkdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import {
  createGitWorktree,
  GitWorktreeError,
  planGitWorktree,
  worktreePathSlug,
} from "../shared/git/worktree.js";
import { installWorkspaceDependencies } from "./workspace-prep.js";
import { runCommand } from "../shared/lib/run-command.js";
import { copyLocalConfigFiles } from "./worktree-local-config.js";

import {
  buildGitContextForWorktree,
  normalizePath,
  probeGitContext,
} from "../shared/git/git-context.js";
import { detectDefaultBranch } from "../shared/git/default-branch.js";

type WorkerOp = CheckoutReadName | "git.context" | "git.defaultBranch";
type Selector = "current" | "launch" | "moved";
type Input<K extends WorkerOp | "checkout.exec"> = {
  directory: string;
  request: Omit<Req<K>, "target">;
} & (K extends "checkout.exec" ? { selector: Selector } : unknown) &
  (K extends "git.context" ? { checkoutBranch?: string } : unknown);

/**
 * Compile `exclude` patterns: regular-expression literals, `/source/flags`.
 * `g` and `y` are dropped, so a test never depends on an earlier one.
 */
export function excludeMatcher(patterns: readonly string[]) {
  const compiled = patterns.map((pattern) => {
    const literal = /^\/(.*)\/([a-z]*)$/s.exec(pattern);
    try {
      if (!literal) throw new Error();
      return new RegExp(literal[1]!, literal[2]!.replace(/[gy]/g, ""));
    } catch {
      throw new RunnerCallError({
        code: "invalid",
        message: `Invalid exclude pattern: ${pattern.slice(0, 200)}`,
      });
    }
  });
  return (path: string) => compiled.some((regex) => regex.test(path));
}

const STATUS_CODES: Record<number, ErrorCode> = {
  400: "invalid",
  403: "forbidden",
  404: "not_found",
  413: "too_large",
};

/**
 * A worker failure as a runner error. A status the app answers with today
 * travels as `details.status`, an OS error code as `details.errno`; the code
 * is the declared one for that status, or `failed`.
 */
function workerError(
  op: WorkerOp | "checkout.exec",
  error: unknown
): RunnerCallError {
  if (error instanceof RunnerCallError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof WorkspaceError) {
    const code = STATUS_CODES[error.status];
    const declared = (
      operations[op].errors as readonly DeclarableError[]
    ).includes(code as DeclarableError);
    return new RunnerCallError({
      code: declared || code === "invalid" ? code! : "failed",
      message,
      details: { status: error.status, class: "workspace" },
    });
  }
  const errno = (error as NodeJS.ErrnoException | null)?.code;
  return new RunnerCallError({
    code: "failed",
    message,
    ...(typeof errno === "string" && { details: { errno } }),
  });
}

/** A diff file with the request's exclusion in place of the app's own test rule. */
function marked<F extends { path: string; isTest?: boolean }>(
  file: F,
  excluded: (path: string) => boolean
) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(file))
    if (key === "isTest") out.excluded = excluded(file.path);
    else out[key] = value;
  if (!("excluded" in out)) out.excluded = excluded(file.path);
  return out;
}

async function work<K extends WorkerOp>(
  op: K,
  { directory, request }: Input<K>
): Promise<unknown> {
  switch (op) {
    case "checkout.list": {
      const { path, filesOnly } = request as Input<"checkout.list">["request"];
      if (filesOnly) {
        const reply = await inspectCheckout(directory, {
          kind: "listFiles",
          path,
        });
        if (reply.kind !== "listFiles")
          throw new Error("Invalid checkout file listing.");
        return {
          entries: reply.names.map((name) => ({
            name,
            path: path + "/" + name,
            kind: "file",
          })),
          truncated: false,
        };
      }
      return readWorkspaceView(directory, { kind: "directory", path });
    }
    case "checkout.preview": {
      const { path } = request as Input<"checkout.preview">["request"];
      return readWorkspaceView(directory, { kind: "preview", path });
    }
    case "checkout.index": {
      const { generation } = request as Input<"checkout.index">["request"];
      return readWorkspaceView(directory, { kind: "index", generation });
    }
    case "checkout.read": {
      const { path, maxBytes } = request as Input<"checkout.read">["request"];
      // The local executor's rules: the caller's base, no recorded one.
      const reply = await inspectCheckout(
        directory,
        { kind: "readFile", path },
        { recordedBase: false }
      );
      if (reply.kind !== "readFile" || reply.content === null) return null;
      const bytes = Buffer.from(reply.content, "utf8");
      if (maxBytes !== null && bytes.length > maxBytes)
        throw new RunnerCallError({
          code: "too_large",
          message: `The file is larger than ${maxBytes} bytes`,
        });
      return {
        data: reply.content,
        digest: createHash("sha256").update(bytes).digest("hex"),
      };
    }
    case "checkout.changes": {
      const { base, fallback } =
        request as Input<"checkout.changes">["request"];
      // Each fallback in order, as the last ref tried after the probes.
      const refs = fallback?.length ? fallback : [undefined];
      let failure: unknown;
      for (const unresolvedBase of refs) {
        try {
          const reply = await inspectCheckout(
            directory,
            { kind: "changes", baseBranch: base },
            { recordedBase: false, unresolvedBase }
          );
          if (reply.kind !== "changes")
            throw new Error("Invalid changes reply");
          const { kind: _kind, ...changes } = reply;
          return changes;
        } catch (error) {
          failure = error;
        }
      }
      throw failure;
    }
    case "checkout.stats": {
      const { base, uncommitted, exclude } =
        request as Input<"checkout.stats">["request"];
      const excluded = excludeMatcher(exclude);
      const computation = await getDiffStatsComputation(directory, base, {
        includeUncommitted: uncommitted,
        isExcluded: excluded,
      });
      if (computation.kind === "failure")
        throw new Error("Git status unavailable.");
      if (!computation.stats) return null;
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(computation.stats))
        out[key === "excludingTests" ? "excluded" : key] = value;
      out.outcome = computation.kind;
      return out;
    }
    case "checkout.diff": {
      const { base, uncommitted, whitespace, exclude, path } =
        request as Input<"checkout.diff">["request"];
      const excluded = excludeMatcher(exclude);
      const options = {
        includeUncommitted: uncommitted,
        ignoreWhitespace: whitespace === "ignore",
      };
      if (path !== undefined)
        return getAgentFileDiff(directory, base, path, undefined, options);
      const diff = (await getAgentDiff(
        directory,
        base,
        undefined,
        options
      )) ?? { baseRef: null, files: [] };
      return {
        ...diff,
        files: diff.files.map((file) => marked(file, excluded)),
      };
    }
  }
  throw new RunnerCallError({
    code: "unsupported",
    message: `Unsupported operation: ${op}`,
  });
}

/**
 * A command's guard file, read where the command runs: a command in the
 * current checkout at that checkout's root, one in a named checkout in it
 * (main's lifecycle hooks). The digest binds the content to the selector,
 * directory and root, so a command never runs against a file read
 * elsewhere.
 */
export async function readCommandGuard(
  directory: string,
  selector: Selector,
  file: string
) {
  const { root, content } = await readCheckoutCommandFile(directory, file, {
    exact: selector !== "current",
  });
  const digest = createHash("sha256")
    .update(JSON.stringify([selector, directory, root, file, content]))
    .digest("hex");
  return { root, content, digest };
}

/**
 * One command, on the caller's terms: no deadline or output limit unless
 * the request names one, spawned directly unless it asks for a login shell.
 * A deadline kills only the direct child, as `runCommand` did; cancelling
 * stops waiting and kills nothing (main ran repo tools without a signal).
 */
async function execCheckoutCommand(
  {
    directory,
    selector,
    request,
  }: {
    directory: string;
    selector: Selector;
    request: Omit<Req<"checkout.exec">, "target">;
  },
  signal?: AbortSignal
): Promise<Res<"checkout.exec">> {
  const { guard, argv, env, timeoutMs, maxOutput, shell } = request;
  const cancelled = () =>
    new RunnerCallError({
      code: "cancelled",
      message: "Checkout command cancelled.",
    });
  if (signal?.aborted) throw cancelled();
  const { root, content, digest } = await readCommandGuard(
    directory,
    selector,
    guard.path
  );
  if (content === null || digest !== guard.digest)
    throw new RunnerCallError({
      code: "stale",
      message:
        "Checkout command authorization is stale. Read the checkout file again.",
    });
  if (signal?.aborted) throw cancelled();
  const [command, ...args] = argv;
  if (!command)
    throw new RunnerCallError({ code: "invalid", message: "Empty command." });
  // The workload's base environment, then the caller's additions.
  const environment = { ...commandBaseEnvironment(), ...env };
  const launch =
    shell === "login"
      ? loginShellCommand(
          argv,
          process.env.SHELL || "/bin/bash",
          environment.PATH
        )
      : { bin: command, args };
  const child = spawn(launch.bin, launch.args, {
    cwd: root,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = capture(child.stdout, maxOutput);
  const stderr = capture(child.stderr, maxOutput);
  return new Promise((resolve, reject) => {
    const cancel = () => reject(cancelled());
    signal?.addEventListener("abort", cancel, { once: true });
    const timer =
      timeoutMs === null
        ? undefined
        : setTimeout(() => {
            // Only the direct child, like runCommand: what it started keeps running.
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
            reject(
              new RunnerCallError({
                code: "timeout",
                message: "Checkout command timed out.",
              })
            );
          }, timeoutMs);
    const settle = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    };
    child.once("error", (error) => {
      settle();
      reject(error);
    });
    child.once("close", (code) => {
      settle();
      const output = stdout();
      const errors = stderr();
      resolve({
        exitCode: code ?? 1,
        stdout: output.text,
        stderr: errors.text,
        ...(maxOutput !== null && {
          truncated: output.truncated || errors.truncated,
        }),
      });
    });
  });
}

export async function readGitContext(
  directory: string,
  checkoutBranch?: string
): Promise<Res<"git.context">> {
  const result = checkoutBranch
    ? await buildGitContextForWorktree({
        worktreePath: directory,
        worktreeBranch: checkoutBranch,
      })
    : await probeGitContext(directory);
  if (result.status === "error")
    throw new RunnerCallError({
      code: "failed",
      message: "Git context probe failed.",
    });
  if (!result.value) return null;
  return {
    ...result.value,
    repoRoot: pathFromWire(result.value.repoRoot),
    worktreePath: pathFromWire(result.value.worktreePath),
  };
}

export const checkoutWorkload = {
  async run<K extends WorkerOp | "checkout.exec">(
    op: K,
    input: Input<K>,
    options: { signal?: AbortSignal }
  ): Promise<Res<K>> {
    try {
      if (op === "git.context")
        return (await readGitContext(
          input.directory,
          (input as Input<"git.context">).checkoutBranch
        )) as Res<K>;
      if (op === "git.defaultBranch")
        return {
          branch: await detectDefaultBranch(input.directory),
        } as Res<K>;
      if (op === "checkout.exec")
        return (await execCheckoutCommand(
          input as unknown as Input<"checkout.exec">,
          options.signal
        )) as Res<K>;
      return (await work(
        op as WorkerOp,
        input as unknown as Input<WorkerOp>
      )) as Res<K>;
    } catch (error) {
      throw workerError(op, error);
    }
  },
};

/** Legacy self-exec names, kept for a runner that started on an older build. */
export const WORKER_ALIASES: Record<string, string> = {
  "runner-view-checkout": "view",
  "runner-inspect-checkout": "inspect",
  "runner-observe-checkout": "observe",
  "runner-watch-checkout": "watch",
};

/**
 * `runner-worker <op> <cwd> [flag]`: one checkout operation as the workload
 * account. The legacy names above map onto it with the same arguments.
 */
export async function runCheckoutWorker(argv: string[]): Promise<void> {
  const [op, cwd, flag] = argv;
  if (op === "read") {
    const input: unknown = await json(process.stdin);
    if (!isCheckoutReadRequest(input, "worker") || !cwd)
      throw new Error("Invalid checkout read request.");
    let reply;
    try {
      reply = {
        data: await checkoutWorkload.run(
          input.op,
          {
            directory: cwd,
            request: input.request,
          },
          {}
        ),
      };
    } catch (error) {
      const { code, message, details } = workerError(input.op, error);
      reply = { error: { code, message, details } };
    }
    process.stdout.write(JSON.stringify(reply));
    return;
  }
  switch (op) {
    case "git-context":
      process.stdout.write(JSON.stringify(await readGitContext(cwd!)));
      return;
    case "view": {
      const { runCheckoutViewCli } = await import("./checkout-view.js");
      return runCheckoutViewCli(cwd!, flag === "--managed");
    }
    case "inspect": {
      const { runCheckoutInspectionCli } =
        await import("./checkout-inspection.js");
      return runCheckoutInspectionCli(cwd!);
    }
    case "observe": {
      const { observeGitCheckout, observeScratchCheckout } =
        await import("./checkout-inspection.js");
      try {
        const observe =
          flag === "--scratch" ? observeScratchCheckout : observeGitCheckout;
        process.stdout.write(JSON.stringify(await observe(cwd!)));
      } catch {
        process.exitCode = 1;
      }
      return;
    }
    case "watch": {
      const { runCheckoutWatchCli } = await import("./checkout-watch.js");
      return runCheckoutWatchCli(cwd!);
    }
  }
  process.stderr.write(`Unknown worker operation: ${op ?? "(none)"}\n`);
  process.exitCode = 2;
}

/** A worktree refusal main answers with its own status, as a runner error. */
function worktreeError(error: unknown): never {
  if (error instanceof GitWorktreeError)
    throw new RunnerCallError({
      code: error.statusCode === 409 ? "conflict" : "invalid",
      message: error.message,
      details: { status: error.statusCode },
    });
  throw error;
}

type WorktreeSpec = {
  directory: string;
  name: string;
  branch: string;
  base: string;
  create: boolean;
  nested?: string;
};

/** `createGitWorktree`'s input for a spec, as main's launch built it. */
function worktreeInput(spec: WorktreeSpec, worktreePath?: string) {
  return {
    cwd: spec.directory,
    name: spec.name,
    branchName: spec.create ? spec.branch : undefined,
    baseBranch: spec.base,
    worktreePath:
      worktreePath ??
      (spec.nested === undefined
        ? undefined
        : path.join(
            spec.directory,
            spec.nested,
            worktreePathSlug(spec.branch, { createNewBranch: spec.create })
          )),
    createNewBranch: spec.create,
  };
}

/** Dependency and copy logs go to the runner's output, which the app logs. */
const stepLine = (...args: unknown[]) => {
  const [object, message] = args;
  process.stderr.write(`${String(message)} ${JSON.stringify(object)}\n`);
};
const stepLog = { info: stepLine, warn: stepLine };

/*
 * The `repository` part of the workspace port: one cached clone per
 * repository, made and fetched with the account's own Git (its config,
 * transports, credential helpers and hooks), tags on. The runner core
 * decides where the clone lives and serialises its use; this does the Git.
 */

const cacheFailed = (message: string) =>
  new RunnerCallError({ code: "failed", message });
const cacheConflict = (message: string) =>
  new RunnerCallError({
    code: "conflict",
    message,
    details: { status: 409 },
  });

async function repositoryGit(args: string[], allowedExitCodes = [0]) {
  return runCommand("git", args, { allowedExitCodes });
}

async function isClone(clone: string) {
  const entry = await lstat(clone).catch(() => null);
  if (!entry) return false;
  if (!entry.isDirectory())
    throw cacheFailed("The repository cache holds something else.");
  const probed = await repositoryGit(
    ["-C", clone, "rev-parse", "--path-format=absolute", "--git-dir"],
    [0, 128]
  );
  return probed.exitCode === 0;
}

/** No branch checked out in the clone, so each one can be a worktree. */
async function detach(clone: string) {
  const head = await repositoryGit(
    ["-C", clone, "rev-parse", "-q", "--verify", "HEAD"],
    [0, 1, 128]
  );
  if (head.exitCode !== 0) return; // An empty repository.
  const branch = await repositoryGit(
    ["-C", clone, "symbolic-ref", "-q", "--short", "HEAD"],
    [0, 1, 128]
  );
  await repositoryGit([
    "-C",
    clone,
    "update-ref",
    "--no-deref",
    "HEAD",
    head.stdout,
  ]);
  // The default branch then comes from the remote like every other one.
  if (branch.exitCode === 0 && branch.stdout)
    await repositoryGit(["-C", clone, "branch", "-D", "--", branch.stdout]);
}

async function defaultBranch(clone: string) {
  const ref = await repositoryGit(
    ["-C", clone, "symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"],
    [0, 1, 128]
  );
  return ref.exitCode === 0 && ref.stdout.startsWith("origin/")
    ? ref.stdout.slice("origin/".length) || null
    : null;
}

const repositoryCache = {
  async cache(url: string, cache: string, clone: string) {
    await mkdir(cache, { recursive: true, mode: 0o700 });
    if (await isClone(clone)) {
      await repositoryGit(["-C", clone, "remote", "set-url", "origin", url]);
      await repositoryGit([
        "-C",
        clone,
        "fetch",
        "--prune",
        "--quiet",
        "origin",
        "+refs/heads/*:refs/remotes/origin/*",
        "+refs/tags/*:refs/tags/*",
      ]).catch(() => {
        throw cacheFailed("Could not fetch the repository.");
      });
      // The remote's default branch may have moved; keep the old one offline.
      await repositoryGit(
        ["-C", clone, "remote", "set-head", "origin", "--auto"],
        [0, 1, 2, 128]
      );
    } else {
      // Cloned aside and renamed, so a crash never leaves a half clone here.
      const partial = `${clone}.partial-${randomUUID()}`;
      try {
        await repositoryGit([
          "clone",
          "--quiet",
          "--no-checkout",
          "--origin",
          "origin",
          "--",
          url,
          partial,
        ]).catch(() => {
          throw cacheFailed("Could not clone the repository.");
        });
        await detach(partial);
        await rename(partial, clone);
      } finally {
        await rm(partial, { recursive: true, force: true });
      }
    }
    return { defaultBranch: await defaultBranch(clone) };
  },

  async pullRequest(clone: string, number: number, branch: string) {
    await repositoryGit([
      "-C",
      clone,
      "fetch",
      "--quiet",
      "origin",
      `refs/pull/${number}/head`,
    ]).catch(() => {
      throw cacheFailed("Could not fetch the pull request head.");
    });
    const head = (
      await repositoryGit([
        "-C",
        clone,
        "rev-parse",
        "--verify",
        "FETCH_HEAD^{commit}",
      ])
    ).stdout;
    const local = await repositoryGit(
      ["-C", clone, "rev-parse", "-q", "--verify", `refs/heads/${branch}`],
      [0, 1, 128]
    );
    if (local.exitCode !== 0) {
      await repositoryGit([
        "-C",
        clone,
        "branch",
        "--no-track",
        "--",
        branch,
        head,
      ]);
      return;
    }
    if (local.stdout === head) return;
    const behind = await repositoryGit(
      ["-C", clone, "merge-base", "--is-ancestor", local.stdout, head],
      [0, 1, 128]
    );
    if (behind.exitCode !== 0)
      throw cacheConflict("The branch has local work; choose another branch.");
    await repositoryGit([
      "-C",
      clone,
      "update-ref",
      `refs/heads/${branch}`,
      head,
      local.stdout,
    ]);
  },
};

export const workspaceWorkload = {
  canonical: async (directory: string) => {
    const found = await stat(directory).catch(() => null);
    return found?.isDirectory() ? realpath(directory) : null;
  },
  /** Main's `set_workspace` check: any stat failure is missing. */
  async locate(directory: string) {
    const found = await stat(directory).catch(() => null);
    if (!found) return "missing" as const;
    if (!found.isDirectory()) return "not_directory" as const;
    try {
      return { directory: normalizePath(await realpath(directory)) };
    } catch {
      return "missing" as const;
    }
  },
  async identity(directory: string) {
    const evidence = await stat(directory, { bigint: true }).catch(() => null);
    return evidence
      ? `${evidence.dev}:${evidence.ino}:${evidence.birthtimeNs}`
      : null;
  },
  async plan(spec: WorktreeSpec) {
    const plan = await planGitWorktree(worktreeInput(spec)).catch(
      worktreeError
    );
    const taken = await access(plan.worktreePath).then(
      () => true,
      () => false
    );
    return { path: plan.worktreePath, branch: plan.branchName, taken };
  },
  async create(spec: WorktreeSpec, worktreePath: string) {
    const result = await createGitWorktree(
      worktreeInput(spec, worktreePath)
    ).catch(worktreeError);
    stepLog.info(
      { worktreePath: result.worktreePath, worktreeBranch: result.branchName },
      "Created worktree."
    );
    return { path: result.worktreePath, branch: result.branchName };
  },
  async copyIgnored(
    source: string,
    destination: string,
    names: readonly string[]
  ) {
    const copied = await copyLocalConfigFiles(source, destination, names);
    if (copied.length > 0)
      stepLog.info(
        { worktreePath: destination, files: copied },
        `Copied ${copied.length} local config file(s) into worktree.`
      );
    return copied;
  },
  async installDependencies(
    directory: string,
    report: (step: {
      status: "done" | "failed";
      detail: string;
    }) => Promise<void>
  ) {
    await installWorkspaceDependencies(directory, stepLog, async (step) => {
      if (step.status)
        await report({ status: step.status, detail: step.detail ?? "" });
    });
  },
  async git(directory: string) {
    const probed = await probeGitContext(directory);
    return probed.status === "error" ? ("error" as const) : probed.value;
  },
  repository: repositoryCache,
};
