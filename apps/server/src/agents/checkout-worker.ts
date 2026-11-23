/*
 * The checkout worker: the workload side of checkout reads, as one entry.
 *
 * - `checkoutWorkload` is the `posix-user` platform's workload for these
 *   operations: a direct call, in the local runner child's own process.
 *   `main.ts` hands it to the runner (`@dispatch/runner/cli`), which types
 *   it structurally; nothing here imports the runner.
 * - `runCheckoutWorker` is the self-exec entry (`runner-worker <op>`) the
 *   Linux runner starts under the workload account.
 *
 * This is runner code that has not moved to `packages/runner` yet; it runs
 * only inside a runner process, never in the app.
 */
import { createHash } from "node:crypto";
import {
  RunnerCallError,
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

type WorkerOp =
  | "checkout.list"
  | "checkout.preview"
  | "checkout.index"
  | "checkout.read"
  | "checkout.stats"
  | "checkout.diff"
  | "checkout.changes";
type Input<K extends WorkerOp> = {
  directory: string;
  request: Omit<Req<K>, "target">;
};

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
function workerError(op: WorkerOp, error: unknown): RunnerCallError {
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
      const { path } = request as Input<"checkout.list">["request"];
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

export const checkoutWorkload = {
  async run<K extends WorkerOp>(
    op: K,
    input: Input<K>,
    _options: { signal?: AbortSignal }
  ): Promise<Res<K>> {
    try {
      return (await work(op, input)) as Res<K>;
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
  switch (op) {
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
