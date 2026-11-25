import { json } from "node:stream/consumers";
import {
  isCheckoutReadRequest,
  parseRunnerRepositoryUrl,
  type GitQueryName,
  type CheckoutReadName,
  validBranch,
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
import { constants, existsSync } from "node:fs";
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
import { getAgentDiffImage } from "../shared/git/diff-image.js";
import {
  inspectCheckout,
  inspectionRoot,
  observeGitCheckout,
} from "./checkout-inspection.js";
import { resolvePath } from "./workspace.js";
import { resolveProjectRoot } from "../projects/resolve-root.js";
import { SharedCheckoutWatches, watchCheckout } from "./checkout-watch.js";
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
  open,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  stat,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import {
  cleanupGitWorktree,
  cleanupWorktreeBranches,
  createGitWorktree,
  GitWorktreeError,
  planGitWorktree,
  worktreePathSlug,
} from "../shared/git/worktree.js";
import { installWorkspaceDependencies } from "./workspace-prep.js";
import { runCommand } from "../shared/lib/run-command.js";
import {
  localPullRequestEvidence,
  localPullRequestStatus,
} from "./remote/github-runner-executor.js";
import { localEngineWorkload } from "./remote/engine-runner-executor.js";
import { configuredLaunchEnvironment } from "./acp/local-host-entry.js";
import { copyLocalConfigFiles } from "./worktree-local-config.js";

import {
  buildGitContextForWorktree,
  normalizePath,
  probeGitContext,
} from "../shared/git/git-context.js";
import { resolveBaseRef } from "../shared/git/base-ref.js";
import { detectDefaultBranch } from "../shared/git/default-branch.js";

type WorkerOp = CheckoutReadName | "git.context" | GitQueryName;
type Selector = "current" | "launch" | "moved";
type Input<K extends WorkerOp | "checkout.exec" | "checkout.write"> = {
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
  op: WorkerOp | "checkout.exec" | "checkout.write",
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
      const { path, filesOnly, unfiltered } =
        request as Input<"checkout.list">["request"];
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
      return readWorkspaceView(
        directory,
        { kind: "directory", path },
        { unfiltered: unfiltered === true }
      );
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
      const {
        path: file,
        maxBytes,
        encoding,
      } = request as Input<"checkout.read">["request"];
      if (encoding === "base64") return readRawBytes(directory, file, maxBytes);
      const path = file;
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
    case "checkout.image": {
      const { base, uncommitted, path, side } =
        request as Input<"checkout.image">["request"];
      const result = await getAgentDiffImage(directory, base, path, side, {
        includeUncommitted: uncommitted,
      });
      if (!result.ok)
        throw new WorkspaceError(
          "Image not available.",
          result.reason === "too-large" ? 413 : 404
        );
      return { bytes: result.buffer.toString("base64") };
    }
    case "checkout.defaultFiles": {
      const { dirs, wait } =
        request as Input<"checkout.defaultFiles">["request"];
      const reply = await inspectCheckout(directory, {
        kind: "defaultBranchFiles",
        directories: dirs,
        waitForRefresh: wait,
      });
      if (reply.kind !== "defaultBranchFiles")
        throw new Error("Invalid default-branch files reply.");
      const { kind: _kind, ...files } = reply;
      return files;
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

async function readGitQuery<K extends GitQueryName>(
  op: K,
  directory: string,
  request: Omit<Req<K>, "target">,
  repository?: string
): Promise<Res<K>> {
  const url =
    repository === undefined ? undefined : parseRunnerRepositoryUrl(repository);
  if (repository !== undefined && (!url || op === "git.base"))
    throw new RunnerCallError({
      code: "invalid",
      message: "Invalid repository target.",
    });
  if (op === "git.branches" || (op === "git.defaultBranch" && url)) {
    const { stdout } = await runCommand(
      "git",
      [
        ...(url ? [] : ["-C", directory]),
        "ls-remote",
        "--symref",
        "--",
        url?.href ?? "origin",
        "HEAD",
        "refs/heads/*",
      ],
      { timeoutMs: 15_000 }
    );
    const defaultBranch = /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(stdout)?.[1];
    if (op === "git.defaultBranch")
      return { branch: defaultBranch ?? null } as Res<K>;
    const branches = [...stdout.matchAll(/^[a-f0-9]+\trefs\/heads\/(.+)$/gm)]
      .map((match) => match[1]!)
      .sort();
    return { branches, ...(defaultBranch && { defaultBranch }) } as Res<K>;
  }
  if (op === "git.defaultBranch")
    return { branch: await detectDefaultBranch(directory) } as Res<K>;
  const { requested, fallback } = request as Omit<Req<"git.base">, "target">;
  return {
    base: await resolveBaseRef(directory, requested, { fallback }),
  } as Res<K>;
}

/** One OS watch per checkout in this process, however many sessions watch it. */
const watches = new SharedCheckoutWatches(watchCheckout);

export const checkoutWorkload = {
  watch(directory: string, changed: () => void, closed: () => void) {
    return watches.subscribe(directory, changed, closed);
  },
  async run<K extends WorkerOp | "checkout.exec" | "checkout.write">(
    op: K,
    input: Input<K>,
    options: { signal?: AbortSignal }
  ): Promise<Res<K>> {
    try {
      if (op === "checkout.write") {
        // Relative to the same root a checkout read resolves against.
        const { root } = await inspectionRoot(input.directory, false);
        return (await writeCheckoutFile(
          root,
          (input as Input<"checkout.write">).request
        )) as Res<K>;
      }
      if (op === "git.context")
        return (await readGitContext(
          input.directory,
          (input as Input<"git.context">).checkoutBranch
        )) as Res<K>;
      if (
        op === "git.defaultBranch" ||
        op === "git.branches" ||
        op === "git.base"
      )
        return (await readGitQuery(
          op,
          input.directory,
          input.request
        )) as Res<K>;
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

const pullRequests = localPullRequestStatus();
const evidence = localPullRequestEvidence();

/** The `posix-user` platform's GitHub port: the user's own `gh`. */
export const githubWorkload = {
  pullRequestStatus(
    { owner, repo, number }: Req<"github.pr.status">,
    options: { signal?: AbortSignal }
  ): Promise<Res<"github.pr.status">> {
    return pullRequests.read(
      { owner, repo, number },
      options.signal
    ) as Promise<Res<"github.pr.status">>;
  },
  pullRequestDetails({
    owner,
    repo,
    number,
  }: Req<"github.pr.details">): Promise<Res<"github.pr.details">> {
    return evidence.details({ owner, repo, number });
  },
  pullRequestDiff({
    owner,
    repo,
    number,
    base,
    head,
  }: Req<"github.pr.diff">): Promise<Res<"github.pr.diff">> {
    return evidence.diff({
      owner,
      repo,
      number,
      ...(base !== undefined && { base }),
      head,
    });
  },
};

/**
 * The `posix-user` platform's session files port: the workload shares this
 * account, so a put hands the file over where it is and a get reads it.
 */
export const sessionFilesWorkload = {
  async put(source: string, purpose: "prompt" | "reference"): Promise<string> {
    // Already visible to the workload. A missing file drops out of the prompt.
    // Listings historically include registry rows even if the file vanished.
    if (purpose === "prompt") await stat(source);
    return source;
  },
  get(source: string): Promise<Buffer> {
    return readFile(source);
  },
};

/**
 * The `posix-user` platform's engine port: this machine's engines with the
 * app's configured CLIs, from the launch settings the app hands its child.
 */
export function localEnginePort(bins = configuredLaunchEnvironment()?.bins) {
  return localEngineWorkload({
    adapter: bins?.adapter,
    claude: bins?.claudeBin ?? "claude",
    ...(bins?.codexBin && { codex: bins.codexBin }),
    ...(bins?.opencodeBin && { opencode: bins.opencodeBin }),
  });
}

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
  if (op && Object.hasOwn(workspaceSteps, op)) {
    const args: unknown = await json(process.stdin);
    if (!Array.isArray(args)) throw new Error("Invalid workspace step.");
    const step = workspaceSteps[op as keyof typeof workspaceSteps] as (
      ...input: unknown[]
    ) => Promise<unknown>;
    let reply;
    try {
      reply = { data: (await step(...args)) ?? null };
    } catch (error) {
      reply = {
        error:
          error instanceof RunnerCallError
            ? {
                code: error.code,
                message: error.message,
                details: error.details,
              }
            : { code: "failed", message: "Workspace step failed." },
      };
    }
    process.stdout.write(JSON.stringify(reply));
    return;
  }
  if (
    op === "git.defaultBranch" ||
    op === "git.branches" ||
    op === "git.base"
  ) {
    const request = await json(process.stdin);
    if (!operations[op].request.check(request))
      throw new Error("Invalid Git query.");
    const repository =
      "repository" in request.target ? request.target.repository : undefined;
    try {
      const data = await readGitQuery(op, cwd ?? "/", request, repository);
      process.stdout.write(JSON.stringify({ data }));
    } catch (error) {
      const { code, message, details } = workerError(op, error);
      process.stdout.write(
        JSON.stringify({ error: { code, message, details } })
      );
    }
    return;
  }
  if (op === "write") {
    // `runner-worker write <cwd>`: one checkout.write as the workload, in
    // the directory the supervisor's own binding named.
    const input: unknown = await json(process.stdin);
    if (
      !cwd ||
      !operations["checkout.write"].request.check({
        ...(input as object),
        target: { path: pathFromWire("/") },
      })
    )
      throw new Error("Invalid checkout write request.");
    let reply;
    try {
      reply = {
        data: await checkoutWorkload.run(
          "checkout.write",
          {
            directory: cwd,
            request: input as Omit<Req<"checkout.write">, "target">,
          },
          {}
        ),
      };
    } catch (error) {
      const { code, message, details } = workerError("checkout.write", error);
      reply = { error: { code, message, details } };
    }
    process.stdout.write(JSON.stringify(reply));
    return;
  }
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
        const observe = argv.includes("--scratch")
          ? observeScratchCheckout
          : observeGitCheckout;
        process.stdout.write(
          JSON.stringify(await observe(cwd!, !argv.includes("--policy-only")))
        );
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
  fromDirectory?: true;
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
  /** Main's launch folder resolution and project matching (`path.resolve`). */
  resolvePath: (raw: string, options?: Omit<Req<"path.resolve">, "path">) =>
    resolvePath(raw, options, resolveProjectRoot),
  /** A session file handed over where it is: the app's `files.put`. */
  putFile: (source: string, { mustExist }: { mustExist: boolean }) =>
    sessionFilesWorkload.put(source, mustExist ? "prompt" : "reference"),
  /** Main's archive observation of a worktree (`observeGitCheckout`). */
  observe: (directory: string) => observeGitCheckout(directory),
  async release(
    _session: string,
    checkout: { path: string; identity?: string },
    request: Pick<Req<"workspace.release">, "deleteBranch" | "originalBranch">
  ) {
    const entry = await lstat(checkout.path, { bigint: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    );
    if (!entry) return true;
    if (
      !entry.isDirectory() ||
      (checkout.identity !== undefined &&
        checkout.identity !== `${entry.dev}:${entry.ino}:${entry.birthtimeNs}`)
    )
      return false;
    const bounded: typeof runCommand = (command, args, options) =>
      runCommand(command, args, {
        ...options,
        timeoutMs: options?.timeoutMs ?? 60_000,
      });
    const root = await bounded("git", [
      "-C",
      checkout.path,
      "rev-parse",
      "--show-toplevel",
    ]);
    if ((await realpath(root.stdout)) !== (await realpath(checkout.path)))
      return false;
    await cleanupGitWorktree(
      { cwd: checkout.path, force: true, ...request },
      bounded
    );
    return true;
  },
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

/** Worktrees in a managed checkout use the empty directory the supervisor
 * created. Its parent stays root-owned throughout preparation. */
async function planManagedWorktree(spec: WorktreeSpec & { at: string }) {
  if (!validBranch(spec.branch) || !validBranch(spec.base))
    throw new RunnerCallError({
      code: "invalid",
      message: "Invalid checkout branch.",
    });
  const entries = await readdir(spec.at);
  return { path: spec.at, branch: spec.branch, taken: entries.length !== 0 };
}

async function createManagedWorktree(spec: WorktreeSpec & { at: string }) {
  const { path: at, branch, taken } = await planManagedWorktree(spec);
  if (taken) throw cacheConflict("The session checkout is already in use.");
  const git = (...args: string[]) =>
    repositoryGit(["-C", spec.directory, ...args]);
  if (spec.create) {
    const remoteBranch = await repositoryGit(
      [
        "-C",
        spec.directory,
        "show-ref",
        "--verify",
        "--quiet",
        `refs/remotes/origin/${branch}`,
      ],
      [0, 1]
    );
    if (remoteBranch.exitCode === 0)
      throw cacheConflict("The new session branch already exists.");
    const base = spec.fromDirectory
      ? await resolveBaseRef(spec.directory, spec.base, { fallback: [] })
      : `refs/remotes/origin/${spec.base}`;
    if (!base)
      throw cacheConflict("Could not resolve the requested session base.");
    await git(
      "worktree",
      "add",
      "--no-track",
      "-b",
      branch,
      "--",
      at,
      base
    ).catch(() => {
      throw cacheConflict("Could not create the requested session branch.");
    });
  } else {
    await git("worktree", "add", "--", at, branch).catch(() => {
      throw cacheConflict("Could not check out the requested session branch.");
    });
  }
  return { path: at, branch };
}

async function madeForUs(at: string, source: string, branch: string) {
  if (!(await lstat(path.join(at, ".git")).catch(() => null))?.isFile())
    return false;
  try {
    const [root, mine, theirs, head] = await Promise.all([
      repositoryGit(["-C", at, "rev-parse", "--show-toplevel"]),
      repositoryGit([
        "-C",
        at,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]),
      repositoryGit([
        "-C",
        source,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]),
      repositoryGit(["-C", at, "symbolic-ref", "--short", "HEAD"]),
    ]);
    return (
      root.stdout === at &&
      mine.stdout === theirs.stdout &&
      head.stdout === branch
    );
  } catch {
    return false;
  }
}

const workspaceSteps = {
  "workspace.canonical": workspaceWorkload.canonical,
  "workspace.locate": workspaceWorkload.locate,
  "workspace.identity": workspaceWorkload.identity,
  "workspace.plan": planManagedWorktree,
  "workspace.create": createManagedWorktree,
  "workspace.madeForUs": madeForUs,
  "workspace.copyIgnored": workspaceWorkload.copyIgnored,
  "workspace.git": workspaceWorkload.git,
  "workspace.cache": repositoryCache.cache,
  "workspace.pullRequest": repositoryCache.pullRequest,
  async "workspace.forgetWorktree"(
    source: string,
    at: string,
    release?: Omit<Req<"workspace.release">, "session">
  ) {
    if (!(await isClone(source))) return;
    const result = await repositoryGit([
      "-C",
      source,
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    const entry = result.stdout
      .split("\0\0")
      .find((record) => record.split("\0")[0] === `worktree ${at}`);
    if (entry === undefined) return;
    const branch =
      entry
        .split("\0")
        .find((line) => line.startsWith("branch refs/heads/"))
        ?.slice("branch refs/heads/".length) ?? null;
    await repositoryGit([
      "-C",
      source,
      "worktree",
      "remove",
      "--force",
      "--",
      at,
    ]);
    if (release)
      await cleanupWorktreeBranches(
        source,
        branch,
        {
          ...release,
          originalBranch: validBranch(release.originalBranch)
            ? release.originalBranch
            : null,
          force: true,
        },
        runCommand
      );
  },
  async "workspace.installDependencies"(directory: string) {
    const steps: Parameters<
      Parameters<typeof workspaceWorkload.installDependencies>[1]
    >[0][] = [];
    await workspaceWorkload.installDependencies(directory, async (step) => {
      steps.push(step);
    });
    return steps;
  },
};

/** The `posix-user` host entry the local runner child starts hosts with. */
export { localHostEntry } from "./acp/local-host-entry.js";

/**
 * A regular file's raw bytes, base64 encoded. A link is followed only to a
 * file inside the checkout; a missing, non-regular or escaping path reads as
 * absent, and a file over `maxBytes` is refused before it is read.
 */
async function readRawBytes(
  directory: string,
  file: string,
  maxBytes: number | null
): Promise<Res<"checkout.read">> {
  if (!file || path.isAbsolute(file) || file.includes("\0")) return null;
  try {
    const root = await realpath(directory);
    const resolved = await realpath(path.join(root, file));
    const inside = path.relative(root, resolved);
    if (
      !inside ||
      inside.startsWith(".." + path.sep) ||
      inside === ".." ||
      path.isAbsolute(inside)
    )
      throw new RunnerCallError({
        code: "forbidden",
        message: "Invalid icon path.",
        details: { reason: "outside" },
      });
    const handle = await open(
      resolved,
      constants.O_RDONLY | constants.O_NONBLOCK
    ).catch((error: NodeJS.ErrnoException) => {
      throw error.code === "EACCES" || error.code === "EPERM"
        ? new RunnerCallError({
            code: "forbidden",
            message: "Icon file not readable.",
            details: { reason: "unreadable" },
          })
        : error;
    });
    try {
      const info = await handle.stat();
      if (!info.isFile()) return null;
      if (maxBytes !== null && info.size > maxBytes)
        throw new RunnerCallError({
          code: "too_large",
          message: `The file is larger than ${maxBytes} bytes`,
        });
      const bytes = await handle.readFile();
      return {
        data: bytes.toString("base64"),
        digest: createHash("sha256").update(bytes).digest("hex"),
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof RunnerCallError) throw error;
    return null;
  }
}

/*
 * `checkout.write`: one file in a session's checkout, written by the
 * workload account itself, only when the file still holds what the caller
 * read (`expectedDigest`; null means it must not exist yet).
 *
 * Nothing here runs with more privilege than the workload: on the Linux
 * runner it is a worker the supervisor starts under the workload's own
 * uid/gid, and locally it is the user's own runner. The refusals below are
 * main's persona-authoring refusals (a symlinked directory or file, a
 * directory outside the checkout), not a confinement of an escalation.
 *
 * Where `/proc/self/fd` exists, every step is bound to an open directory:
 * each segment is opened with `O_NOFOLLOW` through its parent's descriptor,
 * so a symlink swapped in after a check is refused rather than followed.
 * Elsewhere (macOS) it is main's lstat/realpath walk.
 */
/**
 * A transport bound, not a persona limit: persona_upsert's own input caps
 * (instructions 20,000 characters, name 200, description 500) keep a
 * rendered persona under about 81 KiB, so nothing main can write reaches
 * it. A later caller of `checkout.write` owns revisiting it.
 */
export const MAX_CHECKOUT_WRITE_BYTES = 1024 * 1024;

export type CheckoutWriteRefusal =
  | { reason: "symlink-dir"; segment: string }
  | { reason: "symlink-file" }
  | { reason: "outside" }
  | { reason: "invalid-path" }
  | { reason: "not-file" }
  | { reason: "too_large" };

const refuse = (details: CheckoutWriteRefusal, message: string) =>
  new RunnerCallError({ code: "forbidden", message, details });

const stale = () =>
  new RunnerCallError({
    code: "stale",
    message: "The file changed since it was read.",
  });

/** The digest `checkout.read` reports for the same file: SHA-256 of its UTF-8 text. */
export function textDigest(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function segmentsOf(file: string): string[] {
  const segments = file.split("/");
  if (
    !file ||
    file.includes("\0") ||
    file.includes("\\") ||
    path.isAbsolute(file) ||
    segments.some((s) => s === "" || s === "." || s === "..")
  )
    throw refuse(
      { reason: "invalid-path" },
      "The path must be relative to the checkout."
    );
  return segments;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

const symlinkDir = (segment: string) =>
  refuse(
    { reason: "symlink-dir", segment },
    `Refusing to write through symlinked persona directory: ${segment}.`
  );
const symlinkFile = () =>
  refuse(
    { reason: "symlink-file" },
    "Refusing to overwrite a symlinked persona file."
  );
const outside = () =>
  refuse(
    { reason: "outside" },
    "Persona directory must remain inside the current workspace."
  );

const errno = (error: unknown) => (error as NodeJS.ErrnoException)?.code;

/** Compare, then replace in place: main keeps the inode and its mode. */
async function guardedWrite(
  handle: FileHandle,
  data: Buffer,
  expectedDigest: string | null
) {
  const info = await handle.stat();
  if (!info.isFile())
    throw refuse({ reason: "not-file" }, "Not a regular file.");
  if (expectedDigest !== null) {
    const current = (await handle.readFile()).toString("utf8");
    if (textDigest(current) !== expectedDigest) throw stale();
  }
  await handle.truncate(0);
  await handle.write(data, 0, data.length, 0);
}

const fileFlags = (expectedDigest: string | null) =>
  constants.O_RDWR |
  constants.O_NOFOLLOW |
  // A guarded write never creates: the file the caller read must still be there.
  (expectedDigest === null ? constants.O_CREAT | constants.O_EXCL : 0);

/** Main's walk: lstat each directory, refuse links, keep it inside the root. */
async function writeByPath(
  root: string,
  segments: string[],
  data: Buffer,
  expectedDigest: string | null
) {
  const realRoot = await realpath(root);
  let current = realRoot;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    const entry = await lstat(current).catch(() => null);
    if (entry?.isSymbolicLink()) throw symlinkDir(segment);
    if (!entry) await mkdir(current);
    if (!isWithin(realRoot, await realpath(current))) throw outside();
  }
  const filePath = path.join(current, segments.at(-1)!);
  const entry = await lstat(filePath).catch(() => null);
  if (entry?.isSymbolicLink()) throw symlinkFile();
  const handle = await open(filePath, fileFlags(expectedDigest), 0o644).catch(
    (error) => {
      if (errno(error) === "EEXIST") throw stale();
      if (errno(error) === "ENOENT" && expectedDigest !== null) throw stale();
      if (errno(error) === "ELOOP") throw symlinkFile();
      throw error;
    }
  );
  try {
    await guardedWrite(handle, data, expectedDigest);
  } finally {
    await handle.close();
  }
}

const viaFd = (fd: number, name: string) => `/proc/self/fd/${fd}/${name}`;

/** A raw error names the real path, as main's does, not the descriptor's. */
function realError(error: unknown, at: string, real: string): unknown {
  if (!(error instanceof Error)) return error;
  if (!error.message.includes(at)) return error;
  const renamed = new Error(error.message.split(at).join(real));
  Object.assign(renamed, { code: errno(error), path: real });
  return renamed;
}

/** The same walk with each step bound to its parent's open descriptor. */
async function writeByDescriptor(
  root: string,
  segments: string[],
  data: Buffer,
  expectedDigest: string | null
) {
  const opened: FileHandle[] = [];
  const directoryFlags =
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  try {
    let real = await realpath(root);
    let dir = await open(real, constants.O_RDONLY | constants.O_DIRECTORY);
    opened.push(dir);
    for (const segment of segments.slice(0, -1)) {
      const at = viaFd(dir.fd, segment);
      const into = path.join(real, segment);
      const step = async () => {
        try {
          return await open(at, directoryFlags);
        } catch (error) {
          const entry = await lstat(at).catch(() => null);
          if (entry?.isSymbolicLink()) throw symlinkDir(segment);
          if (errno(error) !== "ENOENT") throw realError(error, at, into);
          await mkdir(at).catch((made) => {
            if (errno(made) !== "EEXIST") throw realError(made, at, into);
          });
          return open(at, directoryFlags).catch(async (again) => {
            if ((await lstat(at).catch(() => null))?.isSymbolicLink())
              throw symlinkDir(segment);
            throw realError(again, at, into);
          });
        }
      };
      dir = await step();
      opened.push(dir);
      real = into;
    }
    const name = segments.at(-1)!;
    const at = viaFd(dir.fd, name);
    const handle = await open(at, fileFlags(expectedDigest), 0o644).catch(
      async (error) => {
        if ((await lstat(at).catch(() => null))?.isSymbolicLink())
          throw symlinkFile();
        if (errno(error) === "EEXIST") throw stale();
        if (errno(error) === "ENOENT" && expectedDigest !== null) throw stale();
        throw realError(error, at, path.join(real, name));
      }
    );
    opened.push(handle);
    await guardedWrite(handle, data, expectedDigest);
  } finally {
    for (const handle of opened.reverse()) await handle.close().catch(() => {});
  }
}

const descriptorWalk = () => existsSync("/proc/self/fd");

export async function writeCheckoutFile(
  root: string,
  request: Omit<Req<"checkout.write">, "target">,
  options: { descriptors?: boolean } = {}
): Promise<{ digest: string }> {
  const segments = segmentsOf(request.path);
  const data = Buffer.from(request.data, "utf8");
  if (data.length > MAX_CHECKOUT_WRITE_BYTES)
    throw refuse(
      { reason: "too_large" },
      `The file is larger than ${MAX_CHECKOUT_WRITE_BYTES} bytes.`
    );
  const write =
    (options.descriptors ?? descriptorWalk()) ? writeByDescriptor : writeByPath;
  await write(root, segments, data, request.expectedDigest);
  return { digest: textDigest(request.data) };
}
