import {
  localRunnerSettings,
  enrolledRunnerSettings,
  type RunnerSettings,
} from "./settings-namespace.js";
import type {
  EngineScope,
  EngineHostCallName,
} from "@dispatch/runner-protocol/engine-management";
import { resolveTilde } from "../shared/lib/resolve-tilde.js";
import {
  displayPath,
  pathFromWire,
  operations,
  RunnerCallError,
  runnerIdToWire,
  sessionFromWire,
  sessionToWire,
  type CallName,
  type CallerChannel,
  type CallOptions,
  type OpenName,
  type OperationSpec,
  type Req,
  type Res,
  type Runner,
  type RunnerDescription,
} from "@dispatch/runner-protocol/contract";
import { RUNNER_WIRE_VERSION } from "@dispatch/runner-protocol";
import { typedTerminal } from "../terminal/typed.js";
import type { CheckoutSession } from "./directory.js";
import {
  selfCommand,
  superviseRunner,
  type LaunchedRunner,
  type LauncherBinding,
} from "@dispatch/runner-client/launcher";
import { LocalRunnerSession } from "@dispatch/runner-client/session";
export { operationChannel } from "@dispatch/runner-client/session";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { childProcessEnv } from "../shared/process/child-environment.js";
import { inProcessPorts } from "./in-process.js";
import type {
  InProcessEngines,
  InProcessPorts,
} from "@dispatch/runner-protocol/in-process";
export type { InProcessEngines } from "@dispatch/runner-protocol/in-process";
import { LOCAL_RUNNER_ID } from "./placement.js";
import {
  sessionFileBlob,
  sessionFileBytesBlob,
} from "../files/session-file-blob.js";
import {
  agentDiffPath,
  agentWorkspaceDir,
} from "../agents/workspace-target.js";
import { selectWorkspaceFromResolution } from "./workspace-selection.js";

/** Checkout reads the local runner child serves (T09). */
const CHILD_READS = new Set<CallName>([
  "checkout.access",
  "checkout.list",
  "checkout.preview",
  "checkout.index",
  "checkout.read",
  "checkout.stats",
  "checkout.diff",
  "checkout.changes",
  "checkout.image",
  "checkout.defaultFiles",
]);
type ChildRead =
  | "checkout.access"
  | "checkout.list"
  | "checkout.preview"
  | "checkout.index"
  | "checkout.read"
  | "checkout.stats"
  | "checkout.diff"
  | "checkout.changes"
  | "checkout.image"
  | "checkout.defaultFiles";

type Selector = "current" | "launch" | "moved";
type ChildBinding = { path: string; launch: string | null; moved: boolean };

/**
 * Each child's answers to `workspace.describe`, per connection epoch. Only
 * `workspace.select` changes a binding the child holds (import never
 * replaces one), and it goes through this adapter, which forgets the answer
 * around it; otherwise a found binding is kept until the child reconnects,
 * and not found is asked again. An answer that started before a select is
 * not kept.
 */
type BindingCache = {
  epoch: number;
  bindings: Map<string, ChildBinding>;
  selects: Map<string, number>;
};
const bound = new WeakMap<Runner, BindingCache>();

function bindingCache(child: Runner): BindingCache {
  let cache = bound.get(child);
  if (!cache || cache.epoch !== child.connection.epoch)
    bound.set(
      child,
      (cache = {
        epoch: child.connection.epoch,
        bindings: new Map(),
        selects: new Map(),
      })
    );
  return cache;
}

/** Forget a session's binding: a select is about to change it, or did. */
function forgetBinding(child: Runner, session: string) {
  const cache = bindingCache(child);
  cache.bindings.delete(session);
  cache.selects.set(session, (cache.selects.get(session) ?? 0) + 1);
}

/**
 * The child's binding for the session, asked once: a child that is down or
 * restarting throws `unavailable` at once instead of being waited for.
 */
async function childBinding(
  child: Runner,
  session: Req<"workspace.describe">["session"],
  options: CallOptions<"workspace.describe"> = once()
): Promise<ChildBinding | null> {
  const cache = bindingCache(child);
  const key = sessionToWire(session);
  const known = cache.bindings.get(key);
  if (known !== undefined) return known;
  const selects = cache.selects.get(key) ?? 0;
  try {
    const described = await child.call(
      "workspace.describe",
      { session },
      options
    );
    const binding = {
      path: displayPath(described.path),
      launch: described.checkoutRoot
        ? displayPath(described.checkoutRoot)
        : null,
      moved: described.moved,
    };
    if (bound.get(child) === cache && (cache.selects.get(key) ?? 0) === selects)
      cache.bindings.set(key, binding);
    return binding;
  } catch (error) {
    if (error instanceof RunnerCallError && error.code === "not_found")
      return null;
    throw error;
  }
}

/** Whether the child's binding names `directory` for `selector`. */
function names(binding: ChildBinding | null, selector: Selector, dir: string) {
  if (!binding) return false;
  if (selector === "launch") return binding.launch === dir;
  if (selector === "moved") return binding.moved && binding.path === dir;
  return binding.path === dir;
}

/**
 * The directory a command selector names for the agent row: the launch
 * checkout, the moved workspace (null when none is selected), or the
 * effective one (moved, else launch).
 */
function commandDirectory(agent: CheckoutSession, selector: Selector) {
  const launch = agent.worktreePath ?? agent.cwd;
  const moved = agent.workspacePath;
  if (selector === "launch") return launch;
  if (selector === "moved") return moved && moved !== launch ? moved : null;
  return moved ?? launch;
}

/**
 * One attempt at the child: the session neither waits for a child that is
 * down or restarting nor sends the call again. A local user gets main's
 * answer with main's latency, from the identical port here when needed.
 */
function once<O extends object>(options?: O): O & { wait: false } {
  return { ...(options as O), wait: false };
}

/**
 * A read the child is provably not running: never sent (`unavailable`), its
 * connection lost or closed mid-call (`unknown_outcome`: the child went), or
 * refused while frozen for an update (`fenced`). A read changes nothing, so
 * the identical port runs here.
 */
function readMissed(error: unknown) {
  return (
    error instanceof RunnerCallError &&
    (error.code === "unavailable" ||
      error.code === "unknown_outcome" ||
      error.code === "fenced")
  );
}

/**
 * A mutation the child never received: only then may it run here. An
 * uncertain reply (`unknown_outcome`), `fenced` and `not_found` are the
 * caller's answer.
 */
function neverSent(error: unknown) {
  return error instanceof RunnerCallError && error.code === "unavailable";
}

/**
 * The update fence each local runner session answers to: its parent's own
 * (`LocalRunnerProcess.frozen`), wanted across the child's restarts.
 */
const updateFences = new WeakMap<object, () => boolean>();

/**
 * The child's answer to one attempt, or null when `missed` says the child
 * did not answer and the caller should use the port here.
 */
async function fromChild<T>(
  attempt: () => Promise<T>,
  missed: (error: unknown) => boolean,
  signal?: AbortSignal
): Promise<{ value: T } | null> {
  try {
    return { value: await attempt() };
  } catch (error) {
    if (!missed(error)) throw error;
    signal?.throwIfAborted();
    return null;
  }
}

/**
 * A read sent to a connected child is waited for, as main's read is waited
 * for, until it answers, the connection is lost or closed, or the caller's
 * signal fires; it carries no transport deadline. A read is never run twice:
 * the port here answers only when the child is provably not running it
 * (never sent, connection gone, or fenced), never while the child may be.
 */
function readAtChild<T>(
  send: (options: {
    signal?: AbortSignal;
    timeoutMs: null;
    wait: false;
  }) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  return send({ ...(signal && { signal }), timeoutMs: null, wait: false });
}

/** Rejects with `cancelled` as soon as the caller's signal fires. */
function untilAborted<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  const cancelled = () =>
    new RunnerCallError({ code: "cancelled", message: "Cancelled" });
  if (signal.aborted) {
    work.catch(() => {});
    return Promise.reject(cancelled());
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      work.catch(() => {});
      reject(cancelled());
    };
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      }
    );
  });
}

export function createLocalCheckoutRunner(
  agent: CheckoutSession | undefined,
  description: RunnerDescription,
  child?: Runner
): Runner {
  const {
    checkoutWorkload,
    githubWorkload,
    sessionFilesWorkload,
    workspaceWorkload,
  } = inProcessPorts();
  /**
   * One attempt at the child, or null (use the port here) when there is no
   * child or `missed` says it did not answer. The attempt itself dials a
   * child that is not connected yet, so a restarted child is used again.
   */
  /**
   * A mutation made here only while the parent's update fence is down: a
   * frozen child refuses it with `fenced`, and so does this process while
   * that child is away (it comes back frozen). Reads are not fenced.
   */
  function mayWriteHere() {
    if (child && updateFences.get(child)?.())
      throw new RunnerCallError({
        code: "fenced",
        message: "The runner is frozen for an update",
      });
  }

  function attempt<T>(
    run: (child: Runner) => Promise<T>,
    missed: (error: unknown) => boolean,
    signal?: AbortSignal
  ): Promise<{ value: T } | null> {
    const runner = child;
    if (!runner) return Promise.resolve(null);
    return fromChild(() => run(runner), missed, signal);
  }
  /**
   * One read at the child (`readAtChild`): waited for while the child may
   * be running it; null (the port here answers) only when it provably is
   * not.
   */
  function readAttempt<T>(
    _op: CallName,
    _input: unknown,
    // The local session's own options (one attempt, no transport deadline),
    // built here only: opaque to the contract's call options.
    run: (child: Runner, options: never) => Promise<T>,
    options?: { signal?: AbortSignal }
  ): Promise<{ value: T } | null> {
    return attempt(
      (runner) =>
        readAtChild(
          (read) => run(runner, { ...options, ...read } as never),
          options?.signal
        ),
      readMissed,
      options?.signal
    );
  }

  /**
   * Whether the child holds this session's checkout at `directory`, asked
   * once. A child that cannot answer holds nothing for this call: a read
   * then runs here, and so does a mutation, which was never sent.
   */
  async function childHolds(
    session: Req<"workspace.describe">["session"],
    selector: Selector,
    directory: string,
    options?: { signal?: AbortSignal }
  ): Promise<boolean> {
    const asked = await readAttempt(
      "workspace.describe",
      { session },
      (child, read) => childBinding(child, session, read),
      options
    );
    return asked !== null && names(asked.value, selector, directory);
  }

  /**
   * A checkout read for the bound session: through the child when it holds
   * this session's checkout at the directory the agent row names, else in
   * process with the same workload. Every local launch is prepared and bound
   * by the child (T18), and every move is recorded by it (`workspace.select`,
   * T16), so the second case is temporary (R3) and covers only a session the
   * child holds no binding for (a row its import has not reached, or no
   * child), or a binding that disagrees with the row after a failed write.
   */
  async function read<K extends ChildRead>(
    op: K,
    input: Req<K>,
    options?: CallOptions<K>
  ): Promise<Res<K>> {
    const { target, ...request } = input as Req<ChildRead>;
    // A folder before any session exists: in the child when it is ready,
    // else, and when it dies mid-call, the same port in process (R3).
    if ("path" in target) {
      const answered = await readAttempt(
        op,
        input,
        (child, read) => child.call(op, input, read),
        options
      );
      if (answered) return answered.value;
      return checkoutWorkload.run(
        op,
        { directory: displayPath(target.path), request } as never,
        { signal: options?.signal }
      );
    }
    if (!("session" in target) || sessionToWire(target.session) !== agent?.id)
      throw new RunnerCallError({
        code: "invalid",
        message: "Invalid native checkout binding.",
      });
    if (
      op === "checkout.read" &&
      "mode" in request &&
      request.mode === "command-manifest"
    ) {
      const selector = target.checkout ?? "current";
      if (selector === "owned")
        throw new RunnerCallError({
          code: "invalid",
          message: "Invalid checkout command binding.",
        });
      const dir = commandDirectory(agent, selector);
      if (!dir) return null as Res<K>;
      if (await childHolds(target.session, selector, dir, options)) {
        const answered = await readAttempt(
          op,
          input,
          (child, read) => child.call(op, input, read),
          options
        );
        if (answered) return answered.value;
      }
      return checkoutWorkload.run(
        op,
        { directory: dir, selector, request } as never,
        { signal: options?.signal }
      );
    }
    // A file listing (`filesOnly`) is an inspection read, as on main.
    const views =
      op !== "checkout.read" &&
      op !== "checkout.changes" &&
      op !== "checkout.defaultFiles" &&
      !(op === "checkout.list" && (request as { filesOnly?: true }).filesOnly);
    const row = { baseBranch: null, ...agent };
    // The folder the agent was launched in: where main looks for its icon.
    const launched = target.checkout === "launch";
    const owned =
      (op === "checkout.read" || op === "checkout.access") &&
      target.checkout === "owned";
    const directory = owned
      ? (row.worktreePath ?? row.cwd)
      : launched
        ? (row.launchCwd ?? row.gitContext?.repoRoot ?? row.cwd)
        : op === "checkout.stats" ||
            op === "checkout.diff" ||
            op === "checkout.image"
          ? agentDiffPath(row)
          : agentWorkspaceDir(row);
    if (!directory) {
      if (op === "checkout.stats") return null as Res<K>;
      throw new RunnerCallError({
        code: "not_found",
        message: views
          ? "This agent has no workspace."
          : "The session checkout is unavailable.",
        details: { status: views ? 404 : 409, class: "agent" },
      });
    }
    const answered =
      (await childHolds(
        target.session,
        owned || launched ? "launch" : "current",
        directory,
        options
      )) &&
      (await readAttempt(
        op,
        input,
        (child, read) =>
          child.call(
            op,
            owned
              ? input
              : {
                  ...input,
                  target: {
                    session: target.session,
                    checkout: launched ? "launch" : "current",
                  },
                },
            read
          ),
        options
      ));
    if (answered) return answered.value;
    // The directory the child would read: the row's, which every move
    // (`workspace.select`) records.
    return checkoutWorkload.run(op, { directory, request } as never, {
      signal: options?.signal,
    });
  }

  /**
   * A file write in the bound session's current checkout, by the same rule
   * as reads: in the child when it holds that checkout at the directory the
   * agent row names, else in process with the same workload. It is sent
   * once: only a write the child never received is made here. A lost reply
   * is the caller's answer (`unknown_outcome`); a caller that repeats it by
   * hand gets `stale` from the digest guard if the first one landed.
   */
  async function write(
    input: Req<"checkout.write">,
    options?: CallOptions<"checkout.write">
  ): Promise<Res<"checkout.write">> {
    const { target, ...request } = input;
    if (!("session" in target) || sessionToWire(target.session) !== agent?.id)
      throw new RunnerCallError({
        code: "invalid",
        message: "Invalid native checkout binding.",
      });
    const directory = agentWorkspaceDir({ baseBranch: null, ...agent });
    if (!directory)
      throw new RunnerCallError({
        code: "not_found",
        message: "The session checkout is unavailable.",
        details: { status: 409, class: "agent" },
      });
    const answered =
      (await childHolds(target.session, "current", directory, options)) &&
      (await attempt(
        (child) =>
          child.call(
            "checkout.write",
            {
              ...input,
              target: { session: target.session, checkout: "current" },
            },
            once(options)
          ),
        neverSent,
        options?.signal
      ));
    if (answered) return answered.value;
    mayWriteHere();
    return checkoutWorkload.run(
      "checkout.write",
      { directory, request },
      { signal: options?.signal }
    );
  }

  /**
   * A command for the bound session, by the same rule as reads: in the
   * child when it holds the selected checkout at the directory the agent row
   * names, else in process with the same workload (R3: unbound sessions, as
   * for reads). Sent once: only a command the child never received runs
   * here. The child refuses it with `fenced` while frozen for an update.
   */
  async function exec(
    input: Req<"checkout.exec">,
    options?: CallOptions<"checkout.exec">
  ): Promise<Res<"checkout.exec">> {
    const { target, ...request } = input;
    if (!("session" in target) || sessionToWire(target.session) !== agent?.id)
      throw new RunnerCallError({
        code: "invalid",
        message: "Invalid native checkout command binding.",
      });
    const selector = target.checkout ?? "current";
    const directory = commandDirectory(agent, selector);
    if (!directory)
      throw new RunnerCallError({
        code: "not_found",
        message: "The moved checkout is no longer selected.",
      });
    const answered =
      (await childHolds(target.session, selector, directory, options)) &&
      (await attempt(
        // The child admits mutations through its fence before validating the
        // request. Its checkout handler also defaults a missing selector to current.
        (child) => child.call("checkout.exec", input, once(options)),
        neverSent,
        options?.signal
      ));
    if (answered) return answered.value;
    mayWriteHere();
    return checkoutWorkload.run(
      "checkout.exec",
      { directory, selector, request },
      { signal: options?.signal }
    );
  }

  async function gitContext(
    input: Req<"git.context">,
    options?: CallOptions<"git.context">
  ): Promise<Res<"git.context">> {
    const { target } = input;
    if (!("session" in target) || sessionToWire(target.session) !== agent?.id)
      throw new RunnerCallError({
        code: "invalid",
        message: "Invalid native checkout binding.",
      });
    const selector = target.checkout ?? "current";
    const directory =
      selector === "current" && !agent.workspacePath && !agent.worktreeBranch
        ? agent.cwd
        : commandDirectory(agent, selector);
    if (!directory)
      throw new RunnerCallError({
        code: "not_found",
        message: "The moved checkout is no longer selected.",
      });
    const answered =
      (await childHolds(target.session, selector, directory, options)) &&
      (await readAttempt(
        "git.context",
        input,
        (child, read) => child.call("git.context", input, read),
        options
      ));
    if (answered) return answered.value;
    const checkoutBranch =
      agent.worktreePath === directory &&
      (selector === "launch" ||
        (selector === "current" && !agent.workspacePath))
        ? (agent.worktreeBranch ?? undefined)
        : undefined;
    return checkoutWorkload.run(
      "git.context",
      { directory, request: {}, checkoutBranch },
      {
        signal: options?.signal,
      }
    );
  }

  function boundSession(target: {
    session: Req<"workspace.select">["session"];
  }) {
    if (sessionToWire(target.session) !== agent?.id)
      throw new RunnerCallError({
        code: "invalid",
        message: "Invalid native checkout binding.",
      });
    return agent;
  }

  /**
   * Move the session (`set_workspace`): the child validates the folder and
   * records it in its binding when it holds one; a session it holds no
   * binding for, or a move it never received, is checked in process by the
   * same rule (R3, as for reads) and stays served in process. Sent once.
   */
  async function select(
    input: Req<"workspace.select">,
    options?: CallOptions<"workspace.select">
  ): Promise<Res<"workspace.select">> {
    const session = boundSession(input);
    const key = sessionToWire(input.session);
    // A move the child never received (it is down, or never answered the
    // binding question) is checked here; one it may have recorded is not.
    const held = await readAttempt(
      "workspace.describe",
      { session: input.session },
      (child, read) => childBinding(child, input.session, read),
      options
    );
    if (child && held?.value) {
      forgetBinding(child, key);
      try {
        const answered = await fromChild(
          () => child.call("workspace.select", input, once(options)),
          neverSent,
          options?.signal
        );
        if (answered) return answered.value;
      } finally {
        forgetBinding(child, key);
      }
    }
    mayWriteHere();
    const home = session.worktreePath ?? session.cwd;
    const selected = input.path
      ? await selectWorkspaceFromResolution(
          home,
          displayPath(input.path),
          workspaceWorkload.resolvePath
        )
      : { path: home, moved: false, repoRoot: null };
    return {
      path: pathFromWire(selected.path),
      moved: selected.moved,
      origin: null,
      repositoryRoot: selected.repoRoot
        ? pathFromWire(selected.repoRoot)
        : null,
      checkoutRoot: pathFromWire(home),
    };
  }

  /**
   * A launch folder (`path.resolve`): in the child when it is ready, else,
   * and when it dies mid-call, the same port in process (R3, as for reads).
   */
  async function resolvePath(
    input: Req<"path.resolve">,
    options?: CallOptions<"path.resolve">
  ): Promise<Res<"path.resolve">> {
    const answered = await readAttempt(
      "path.resolve",
      input,
      (child, read) => child.call("path.resolve", input, read),
      options
    );
    if (answered) return answered.value;
    const { path: requested, ...rest } = input;
    if (rest.automatic) return inProcessPorts().launchProbes.inspect(requested);
    return workspaceWorkload.resolvePath(requested, rest);
  }

  /** Folder branch reads use the child, or the same workload if it cannot answer. */
  async function branches(
    input: Req<"git.branches">,
    options?: CallOptions<"git.branches">
  ): Promise<Res<"git.branches">> {
    if ("repository" in input.target) {
      if (!child)
        throw new RunnerCallError({
          code: "unavailable",
          message: "The local runner is unavailable",
        });
      return child.call("git.branches", input, options);
    }
    if (!("path" in input.target))
      throw new RunnerCallError({
        code: "unsupported",
        message: "Branches are read for a path.",
      });
    const directory = resolveTilde(displayPath(input.target.path));
    const request = { target: { path: pathFromWire(directory) } };
    const answered = await readAttempt(
      "git.branches",
      request,
      (child, read) => child.call("git.branches", request, read),
      options
    );
    if (answered) return answered.value;
    return checkoutWorkload.run(
      "git.branches",
      { directory, request: {} },
      { signal: options?.signal }
    );
  }

  /** Read the selected checkout's default through its child, with Local's read fallback. */
  async function defaultBranch(
    input: Req<"git.defaultBranch">,
    options?: CallOptions<"git.defaultBranch">
  ): Promise<Res<"git.defaultBranch">> {
    const { target } = input;
    if ("repository" in target) {
      if (!child)
        throw new RunnerCallError({
          code: "unavailable",
          message: "The local runner is unavailable",
        });
      return child.call("git.defaultBranch", input, options);
    }
    let directory: string;
    let atChild = true;
    if ("path" in target) directory = displayPath(target.path);
    else {
      if (sessionToWire(target.session) !== agent?.id)
        throw new RunnerCallError({
          code: "invalid",
          message: "Invalid native checkout binding.",
        });
      const selector = target.checkout ?? "current";
      const selected = commandDirectory(agent, selector);
      if (!selected)
        throw new RunnerCallError({
          code: "not_found",
          message: "The session checkout is unavailable.",
        });
      directory = selected;
      atChild = await childHolds(target.session, selector, directory, options);
    }
    const answered =
      atChild &&
      (await readAttempt(
        "git.defaultBranch",
        input,
        (child, read) => child.call("git.defaultBranch", input, read),
        options
      ));
    if (answered) return answered.value;
    return checkoutWorkload.run(
      "git.defaultBranch",
      { directory, request: {} },
      { signal: options?.signal }
    );
  }

  /**
   * GitHub reads (status, merge-risk details and diff) as the user's own
   * `gh`: in the child when it
   * serves, else in process with the same port (R3, as for reads). A child
   * that dies or restarts during the call is the same as one not ready: the
   * read runs in process, so a local user never sees the transport. A gh
   * failure the child answered with is the read's answer.
   */
  async function github<
    K extends
      | "github.pr.head"
      | "github.pr.status"
      | "github.pr.details"
      | "github.pr.diff",
  >(op: K, input: Req<K>, options?: CallOptions<K>): Promise<Res<K>> {
    const answered = await readAttempt(
      op,
      input,
      (child, read) => child.call(op, input, read),
      options
    );
    if (answered) return answered.value;
    const port = { signal: options?.signal };
    if (op === "github.pr.head")
      return githubWorkload.pullRequestHead(
        input as Req<"github.pr.head">
      ) as Promise<Res<K>>;
    if (op === "github.pr.details")
      return githubWorkload.pullRequestDetails(
        input as Req<"github.pr.details">
      ) as Promise<Res<K>>;
    if (op === "github.pr.diff")
      return githubWorkload.pullRequestDiff(
        input as Req<"github.pr.diff">
      ) as Promise<Res<K>>;
    return githubWorkload.pullRequestStatus(
      input as Req<"github.pr.status">,
      port
    ) as Promise<Res<K>>;
  }

  /**
   * The Files pane's watch, by the same rule as reads: in the child when it
   * holds this session's checkout at the directory the agent row names,
   * else in process with the same workload (R3, as for reads).
   */
  async function watch(
    input: Req<"checkout.watch">,
    options?: CallOptions<"checkout.watch">
  ): Promise<{
    info: Res<"checkout.watch">;
    channel: CallerChannel<"checkout.watch">;
  }> {
    const { target } = input;
    if (!("session" in target) || sessionToWire(target.session) !== agent?.id)
      throw new RunnerCallError({
        code: "invalid",
        message: "Invalid native checkout binding.",
      });
    const directory = agentWorkspaceDir({ baseBranch: null, ...agent });
    if (!directory)
      throw new RunnerCallError({
        code: "not_found",
        message: "This agent has no workspace.",
      });
    // A watch the child cannot open runs here, as main watches, for the
    // life of this subscription: a child that comes back later does not
    // take it over, so no pulse is doubled or dropped.
    const opened =
      (await childHolds(target.session, "current", directory, options)) &&
      (await attempt(
        (child) =>
          child.open(
            "checkout.watch",
            { target: { session: target.session, checkout: "current" } },
            once(options)
          ),
        // Opening takes no per-call deadline: a `timeout` here can only be
        // the transport's, never a workload's answer, so it is missed too.
        (error) =>
          readMissed(error) ||
          (error instanceof RunnerCallError && error.code === "timeout"),
        options?.signal
      ));
    if (opened) return opened.value;
    return { info: {}, channel: pulses(directory) };
  }

  /**
   * Session files for the bound session. A put hands the file over where it
   * is, so its path is the one the agent opens: in the child when it is
   * ready and holds the session (the socket passes the path in place, with
   * no read), once; else, and when the child never received it, the same
   * port in process (R3). A lost reply is the caller's answer. A get stays
   * in process: the local socket has no
   * frame that returns bytes, and main's one read returns them unencoded.
   */
  async function files<K extends "files.put" | "files.get">(
    op: K,
    input: Req<K>
  ): Promise<Res<K>> {
    if (sessionToWire(input.session) !== agent?.id)
      throw new RunnerCallError({
        code: "invalid",
        message: "Invalid session file binding.",
      });
    if (op === "files.put") {
      const file = sessionFileBlob((input as Req<"files.put">).blob);
      const local = child as
        | (Runner & Partial<Pick<LocalRunnerSession, "sendBlob">>)
        | undefined;
      const held = local?.sendBlob
        ? await readAttempt(
            "workspace.describe",
            { session: input.session },
            (child, read) => childBinding(child, input.session, read)
          )
        : null;
      if (local?.sendBlob && held?.value) {
        // The app's token stays here; the child gets a path in place. One
        // attempt for the call and its blob, both settled before anything
        // else happens: no waiter is left behind.
        const blob = `file:${randomUUID()}`;
        const [answer] = await Promise.allSettled([
          local.call(
            "files.put",
            { ...(input as Req<"files.put">), blob },
            once<CallOptions<"files.put">>()
          ),
          local.sendBlob(blob, {
            path: file.path,
            inPlace: { mustExist: file.purpose === "prompt" },
          }),
        ]);
        if (answer.status === "fulfilled") return answer.value as Res<K>;
        // Only a put the child never received is made here.
        if (!neverSent(answer.reason)) throw answer.reason;
      }
      mayWriteHere();
      return {
        path: pathFromWire(
          await sessionFilesWorkload.put(file.path, file.purpose)
        ),
      } as Res<K>;
    }
    // One read, as main: the caller takes these bytes back by `blob`.
    const source = (input as Req<"files.get">).path;
    const bytes = await sessionFilesWorkload.get(source);
    return {
      name: path.basename(source),
      size: bytes.length,
      // The transport's, from the bytes `blob` names, when it needs it.
      digest: "",
      blob: sessionFileBytesBlob(bytes),
    } as Res<K>;
  }

  return {
    describe: () => description,
    connection: child?.connection ?? {
      state: "unavailable",
      epoch: 0,
      onChange: () => () => {},
    },
    async call<K extends CallName>(
      op: K,
      input: Req<K>,
      options?: CallOptions<K>
    ): Promise<Res<K>> {
      if (op === "runner.describe") return description as Res<K>;
      if (
        ("target" in input &&
          input.target &&
          typeof input.target === "object" &&
          "repository" in input.target) ||
        op === "github.account" ||
        op === "github.login.start" ||
        op === "github.login.cancel" ||
        op === "github.logout" ||
        op === "github.branches" ||
        op === "github.repositories" ||
        op === "workspace.prepare" ||
        op === "workspace.resume" ||
        op === "workspace.observe" ||
        op === "workspace.release" ||
        op === "session.retire" ||
        op === "session.discard"
      ) {
        if (!child)
          throw new RunnerCallError({
            code: "unavailable",
            message: "The local runner is unavailable",
          });
        if (
          op === "workspace.release" ||
          op === "session.retire" ||
          op === "session.discard"
        )
          mayWriteHere();
        const archiveOperation =
          op === "workspace.observe" ||
          op === "workspace.release" ||
          op === "session.retire" ||
          op === "session.discard";
        return child.call(
          op,
          input,
          archiveOperation ? once(options) : options
        );
      }
      if (CHILD_READS.has(op))
        return read(
          op as ChildRead,
          input as Req<ChildRead>,
          options as CallOptions<ChildRead>
        ) as Promise<Res<K>>;
      if (op === "checkout.write")
        return write(
          input as Req<"checkout.write">,
          options as CallOptions<"checkout.write">
        ) as Promise<Res<K>>;
      if (op === "git.context")
        return gitContext(input as Req<"git.context">, options) as Promise<
          Res<K>
        >;
      if (op === "workspace.select")
        return select(
          input as Req<"workspace.select">,
          options as CallOptions<"workspace.select">
        ) as Promise<Res<K>>;
      if (op === "git.roots") {
        const request = input as Req<"git.roots">;
        const target = request.target;
        let directory: string | null;
        if ("path" in target) directory = displayPath(target.path);
        else if (
          "session" in target &&
          sessionToWire(target.session) === agent?.id
        )
          directory = commandDirectory(agent, target.checkout ?? "current");
        else
          throw new RunnerCallError({
            code: "invalid",
            message: "Invalid native checkout binding.",
          });
        if (directory === null)
          throw new RunnerCallError({
            code: "not_found",
            message: "The session checkout is unavailable.",
          });
        // One attempt, by the rule for every read: for a session, only
        // when the child holds that checkout at the row's directory.
        const answered =
          (!("session" in target) ||
            (await childHolds(
              target.session,
              target.checkout ?? "current",
              directory,
              options
            ))) &&
          (await readAttempt(
            "git.roots",
            request,
            (child, read) => child.call("git.roots", request, read),
            options
          ));
        if (answered) return answered.value as Res<K>;
        return checkoutWorkload.run(
          "git.roots",
          {
            directory,
            request:
              request.checkoutOnly === true ? { checkoutOnly: true } : {},
          },
          { signal: options?.signal }
        ) as Promise<Res<K>>;
      }
      if (op === "git.origin") {
        const request = input as Req<"git.origin">;
        const answered = await readAttempt(
          "git.origin",
          request,
          (child, read) => child.call("git.origin", request, read),
          options
        );
        if (answered) return answered.value as Res<K>;
        return checkoutWorkload.run(
          "git.origin",
          { directory: request.path, request },
          { signal: options?.signal }
        ) as Promise<Res<K>>;
      }
      if (op === "path.complete" || op === "git.remoteHeads") {
        const answered = await readAttempt(
          op,
          input,
          (child, read) => child.call(op, input, read),
          options
        );
        if (answered) return answered.value;
        const { launchProbes } = inProcessPorts();
        return (
          op === "path.complete"
            ? launchProbes.complete(input as Req<"path.complete">)
            : launchProbes.remoteHeads(input as Req<"git.remoteHeads">)
        ) as Promise<Res<K>>;
      }
      if (op === "path.resolve")
        return resolvePath(
          input as Req<"path.resolve">,
          options as CallOptions<"path.resolve">
        ) as Promise<Res<K>>;
      if (op === "git.branches")
        return branches(
          input as Req<"git.branches">,
          options as CallOptions<"git.branches">
        ) as Promise<Res<K>>;
      if (op === "git.defaultBranch")
        return defaultBranch(
          input as Req<"git.defaultBranch">,
          options as CallOptions<"git.defaultBranch">
        ) as Promise<Res<K>>;
      if (op === "files.put" || op === "files.get")
        return files(op as "files.put", input as Req<"files.put">) as Promise<
          Res<K>
        >;
      if (op === "checkout.exec")
        return exec(
          input as Req<"checkout.exec">,
          options as CallOptions<"checkout.exec">
        ) as Promise<Res<K>>;
      if (
        op === "github.pr.head" ||
        op === "github.pr.status" ||
        op === "github.pr.details" ||
        op === "github.pr.diff"
      )
        return github(
          op as "github.pr.status",
          input as Req<"github.pr.status">,
          options as CallOptions<"github.pr.status">
        ) as Promise<Res<K>>;
      throw new RunnerCallError({
        code: "unsupported",
        message: `Unsupported operation: ${op}`,
      });
    },
    async open<K extends OpenName>(
      op: K,
      input: Req<K>,
      options?: CallOptions<K>
    ): Promise<{ info: Res<K>; channel: CallerChannel<K> }> {
      if (op !== "checkout.watch")
        throw new RunnerCallError({
          code: "unsupported",
          message: `Unsupported operation: ${op}`,
        });
      return watch(
        input as Req<"checkout.watch">,
        options as CallOptions<"checkout.watch">
      ) as Promise<{ info: Res<K>; channel: CallerChannel<K> }>;
    },
  };
}

/** An in-process watch as the caller's end of a `checkout.watch` channel. */
function pulses(directory: string): CallerChannel<"checkout.watch"> {
  const data = new Set<(pulse: Uint8Array) => void>();
  const closes = new Set<(error?: undefined) => void>();
  let open = true;
  const end = () => {
    if (!open) return;
    open = false;
    stop();
    for (const listener of closes) listener();
  };
  const stop = inProcessPorts().checkoutWorkload.watch(
    directory,
    () => {
      if (open) for (const listener of data) listener(PULSE);
    },
    end
  );
  return {
    write() {},
    onData(listener) {
      data.add(listener);
      return () => data.delete(listener);
    },
    onClose(listener) {
      closes.add(listener);
      return () => closes.delete(listener);
    },
    close: end,
  };
}
const PULSE = new Uint8Array([0x31]);

/** The local runner child as its callers use it: a `Runner` with streams. */
export type LocalRunner = Omit<Runner, "call"> &
  Pick<LocalRunnerSession, "call" | "openStream">;

export {
  localHostChannel,
  openLocalSession,
  sessionHostStream,
  launchLocalSession,
  readLocalSession,
  requestLocalSession,
  type LocalSessionRunner,
} from "@dispatch/runner-client/session/operations";

export type LocalRunnerLog = {
  info(object: object, message: string): void;
  warn(object: object, message: string): void;
};

/**
 * The updater's view of the child. Every answer is fresh; anything the child
 * cannot confirm in time is an error, never a guess.
 */
export type LocalRunnerFence = {
  /** `idle`, or why the child cannot be counted idle (`unavailable` included). */
  activity(): Promise<"idle" | "unavailable" | "busy">;
  /** Freeze the child's writes; resolves only on the child's confirmation. */
  freeze(): Promise<void>;
  /** Release the fence; a child started later starts thawed. */
  thaw(): Promise<void>;
  /**
   * The frozen child's own session count, read now. Throws when the child is
   * not confirmed frozen or does not answer.
   */
  frozenSessions(): Promise<number>;
};

export type EngineCallName =
  | "engine.models"
  | "engine.usage"
  | "engine.quota.reset"
  | "engine.update.inspect"
  | "engine.update.spawn"
  | "engine.update.release"
  | "engine.update.probe"
  | "engine.operation"
  | "engine.plugin.status"
  | "engine.plugin.apply"
  | "engine.list"
  | "engine.login.start"
  | "engine.login.submit"
  | "engine.login.status"
  | "engine.login.cancel";

/** Engine inventory and sign-in on one runner, by protocol operation. */
export type RunnerEngineCalls = EngineCalls & { settings: RunnerSettings };

export type EngineCalls = {
  call<K extends EngineCallName>(
    op: K,
    input: Req<K>,
    options?: CallOptions<K>
  ): Promise<Res<K>>;
};

/** A call the child never answered: it was not there, or went mid-call. */
const childMissed = (error: unknown) =>
  error instanceof RunnerCallError &&
  (error.code === "unavailable" ||
    error.code === "unknown_outcome" ||
    error.code === "fenced");

/** The child's engine port in this process, with the app's configured CLIs. */
export function inProcessEngines(
  bins: Parameters<InProcessPorts<Buffer>["localEnginePort"]>[0],
  frozen: () => boolean = () => false
): InProcessEngines {
  const port = inProcessPorts().localEnginePort(bins);
  const guard =
    <A extends unknown[], R>(run: (...args: A) => R) =>
    (...args: A): R => {
      if (frozen())
        throw new RunnerCallError({
          code: "fenced",
          message: "The runner is frozen for an update",
        });
      return run(...args);
    };
  port.models = guard(port.models.bind(port));
  port.quotaReset = guard(port.quotaReset.bind(port));
  port.updateSpawn = guard(port.updateSpawn.bind(port));
  port.updateRelease = guard(port.updateRelease.bind(port));
  port.pluginApply = guard(port.pluginApply.bind(port));
  return port;
}

/**
 * The local placement's engines: in the child when it serves, else in
 * process with the same port (R3, as for reads). A sign-in the child does
 * not know may be one started in process while it was away, so a login
 * looked up by ID is asked of both.
 */
export function localEngineCalls(
  child: () => Runner | undefined,
  inProcess: InProcessEngines
): RunnerEngineCalls {
  async function here<K extends EngineCallName>(
    op: K,
    input: Req<K>,
    options?: CallOptions<K>
  ): Promise<Res<K>> {
    switch (op) {
      case "engine.models":
        return (await inProcess.models(
          input as Req<"engine.models">
        )) as Res<K>;
      case "engine.usage":
        return (await inProcess.usage(input as Req<"engine.usage">)) as Res<K>;
      case "engine.quota.reset":
        return (await inProcess.quotaReset(
          input as Req<"engine.quota.reset">
        )) as Res<K>;
      case "engine.update.inspect":
        return (await inProcess.updateInspect(
          input as Req<"engine.update.inspect">
        )) as Res<K>;
      case "engine.update.spawn":
        return (await inProcess.updateSpawn(
          input as Req<"engine.update.spawn">
        )) as Res<K>;
      case "engine.update.release":
        return (await inProcess.updateRelease(
          input as Req<"engine.update.release">
        )) as Res<K>;
      case "engine.update.probe":
        return (await inProcess.updateProbe(
          input as Req<"engine.update.probe">
        )) as Res<K>;
      case "engine.operation":
        return (await inProcess.operation(
          input as Req<"engine.operation">
        )) as Res<K>;
      case "engine.plugin.status":
        return (await inProcess.pluginStatus(
          input as Req<"engine.plugin.status">
        )) as Res<K>;
      case "engine.plugin.apply":
        return (await inProcess.pluginApply(
          input as Req<"engine.plugin.apply">
        )) as Res<K>;
      case "engine.list":
        return (await inProcess.list(input as Req<"engine.list">)) as Res<K>;
      case "engine.login.start":
        return (await inProcess.loginStart(
          input as Req<"engine.login.start">,
          (login) =>
            (
              options as CallOptions<"engine.login.start"> | undefined
            )?.onEvent?.({ type: "login_update", login })
        )) as Res<K>;
      case "engine.login.submit":
        return (await inProcess.loginSubmit(
          input as Req<"engine.login.submit">
        )) as Res<K>;
      case "engine.login.status":
        return (await inProcess.loginStatus(
          input as Req<"engine.login.status">
        )) as Res<K>;
      default:
        return (await inProcess.loginCancel(
          input as Req<"engine.login.cancel">
        )) as Res<K>;
    }
  }
  return {
    settings: localRunnerSettings,
    async call(op, input, options) {
      const runner = child();
      // Mutation replay protection belongs to the owning host. A lost
      // acknowledgement must not replay against a restarted or fallback host.
      const singleAttempt =
        op === "engine.quota.reset" ||
        op === "engine.update.spawn" ||
        op === "engine.update.release" ||
        op === "engine.plugin.apply";
      // A sign-in is unchanged: it may wait for a restarting child (and a
      // fenced one is made here, in the engine's own store). Every other
      // operation is one attempt: a read then runs here at once.
      const signIn =
        op === "engine.login.start" ||
        op === "engine.login.submit" ||
        op === "engine.login.cancel";
      // A read (the contract's retry rule) is waited for at the child, as
      // checkout reads are: never run here while the child may be running it
      // (`engine.models` starts an engine session).
      const read =
        !signIn && (operations[op] as OperationSpec).retry.kind === "read";
      if (runner?.connection.state === "ready")
        try {
          if (read)
            return await readAtChild(
              (attempt) =>
                runner.call(op, input, { ...options, ...attempt } as never),
              options?.signal
            );
          const attempt = signIn ? options : { ...options, wait: false };
          return await runner.call(op, input, attempt);
        } catch (error) {
          if (
            op === "engine.models" &&
            error instanceof RunnerCallError &&
            error.code === "fenced"
          )
            throw error;
          if (
            singleAttempt &&
            (!(error instanceof RunnerCallError) ||
              error.code !== "unavailable")
          )
            throw error;
          const byId = op !== "engine.list" && op !== "engine.login.start";
          if (
            !childMissed(error) &&
            !(
              byId &&
              error instanceof RunnerCallError &&
              error.code === "not_found"
            )
          )
            throw error;
          options?.signal?.throwIfAborted();
        }
      // The caller's cancellation ends the wait here too.
      return untilAborted(here(op, input, options), options?.signal);
    },
  };
}

/** The child as a `Runner`, while the app has one. */
export function localRunnerOf(process: LocalRunnerProcess | undefined) {
  return process?.runner;
}

export type LocalRunnerProcess = LocalRunnerFence & {
  readonly frozen: boolean;
  /** The child as a `Runner`: one connection, retried while unavailable. */
  runner: LocalRunnerSession;
  stop(graceMs?: number): Promise<void>;
};

const FENCE_ANSWER_MS = 10_000;
const IMPORT_ANSWER_MS = 60_000;
const READ_MS = 5_000;

/** The child as the fence sees it: the launcher's handle. */
type FenceChild = Pick<LaunchedRunner, "pid" | "fence"> & {
  ready: Pick<LaunchedRunner["ready"], "frozen">;
};

/**
 * The fence over one supervised child. `wanted` is read at each (re)start so
 * a restarted child stays frozen; `ready` records each child that came up.
 * Reads go through the session without waiting: unavailable is an answer of
 * its own, never treated as idle or empty.
 */
export function createLocalRunnerFence(input: {
  runner: Pick<LocalRunnerSession, "call">;
  /** The child running now, or null while it is down. */
  current: () => FenceChild | null;
  frozen: boolean;
  log: LocalRunnerLog;
}): LocalRunnerFence & {
  readonly wanted: boolean;
  ready(child: FenceChild | null): void;
} {
  const { runner, current, log } = input;
  let frozen = input.frozen;
  // The running child that confirmed it is frozen, by `fence` or `ready`.
  let confirmed: FenceChild | null = null;
  const health = () =>
    runner.call(
      "runner.health",
      {},
      { wait: false, signal: AbortSignal.timeout(READ_MS) }
    );
  return {
    get wanted() {
      return frozen;
    },
    ready(child) {
      confirmed = child?.ready.frozen ? child : null;
    },
    async activity() {
      try {
        return (await health()).working > 0 ? "busy" : "idle";
      } catch {
        return "unavailable";
      }
    },
    async freeze() {
      frozen = true;
      const child = current();
      if (!child) throw new Error("The local runner is unavailable");
      await child.fence(true, FENCE_ANSWER_MS);
      if (!frozen || current() !== child)
        throw new Error("The local runner changed while freezing");
      confirmed = child;
      log.info({ pid: child.pid }, "Local runner frozen");
    },
    async thaw() {
      frozen = false;
      confirmed = null;
      const child = current();
      if (!child) return;
      await child.fence(false, FENCE_ANSWER_MS);
      log.info({ pid: child.pid }, "Local runner thawed");
    },
    async frozenSessions() {
      const child = current();
      if (!frozen || !child || confirmed !== child)
        throw new Error("The local runner is not confirmed frozen");
      // The child counts its live hosts as `session.list` reads them.
      const sample = await health();
      // The answer must come from the child that confirmed the fence.
      if (current() !== child || confirmed !== child)
        throw new Error("The local runner changed while it was read");
      return sample.sessions;
    },
  };
}

/**
 * Start this app's local runner as a child (`<this executable> local-runner`)
 * and keep it running: exact build handshake, EOF lifeline, restart with
 * backoff. It never blocks start-up, and nothing is routed through it yet:
 * if it cannot start, the app logs, backs off and retries.
 */
export function startLocalRunnerProcess(options: {
  stateRoot: string;
  filesRoot: string;
  launchEnvironment?: string;
  build: { version: string; revision: string | null };
  log: LocalRunnerLog;
  /** Start frozen (an update's probation): writes are refused until `thaw`. */
  frozen?: boolean;
  /**
   * Bindings for sessions older builds started, read fresh each time. Sent
   * to every child that comes up thawed and again after `thaw`; the child
   * keeps any binding it already holds, so repeating is safe.
   */
  bindings?: () => Promise<LauncherBinding[]>;
  onReady?: () => void;
  /** The child's argv; default this executable's own `local-runner` mode. */
  command?: string[];
}): LocalRunnerProcess {
  const { log } = options;
  const importBindings = async (child: LaunchedRunner) => {
    if (!options.bindings) return;
    try {
      const answer = await child.importBindings(
        await options.bindings(),
        IMPORT_ANSWER_MS
      );
      if (answer.error || answer.invalid)
        log.warn(
          { pid: child.pid, ...answer },
          "Local runner did not store every binding"
        );
      else if (!answer.frozen)
        log.info(
          {
            pid: child.pid,
            added: answer.added,
            kept: answer.kept,
          },
          "Local runner bindings imported"
        );
    } catch (err) {
      log.warn({ pid: child.pid, err }, "Local runner binding import failed");
    }
  };
  const runnerId = runnerIdToWire(LOCAL_RUNNER_ID);
  const runner = new LocalRunnerSession({
    description: {
      runnerId: LOCAL_RUNNER_ID,
      displayName: "Local",
      build: {
        version: options.build.version,
        ...(options.build.revision && { revision: options.build.revision }),
      },
      protocol: RUNNER_WIRE_VERSION,
      engines: [],
      capabilities: {},
    },
  });
  const fence = createLocalRunnerFence({
    runner,
    current: () =>
      supervisor.state.state === "ready" ? supervisor.state.runner : null,
    frozen: options.frozen === true,
    log,
  });
  // The adapter's mutations made in process answer to this same fence.
  updateFences.set(runner, () => fence.wanted);
  const supervisor = superviseRunner({
    command: options.command ?? selfCommand("local-runner"),
    // Main's child-environment scrub: no database URL, tokens or API keys.
    env: {
      ...childProcessEnv(),
      DISPATCH_LOCAL_RUNNER_LAUNCH: options.launchEnvironment,
    },
    start: {
      build: {
        version: options.build.version,
        ...(options.build.revision && { revision: options.build.revision }),
      },
      roots: { state: options.stateRoot, files: options.filesRoot },
      config: {
        runnerId,
        displayName: "Local",
        engines: [],
        // The child's environment is scrubbed; the host's argv is the app's.
        hostCommand: inProcessPorts().hostCommand(),
      },
    },
    frozen: () => fence.wanted,
    onStderr: (line) => log.info({ localRunner: line }, "Local runner output"),
    onState(state) {
      fence.ready(state.state === "ready" ? state.runner : null);
      if (state.state === "ready") {
        const { pid, ready } = state.runner;
        log.info({ pid }, "Local runner ready");
        runner.setEndpoint({ socket: ready.socket, nonce: ready.nonce });
        // A frozen child stores nothing; `thaw` sends the import instead.
        if (!ready.frozen) void importBindings(state.runner);
        // A start-up self-check over the socket; nothing else uses it yet.
        const signal = AbortSignal.timeout(10_000);
        void Promise.all([
          runner.call("runner.describe", {}, { signal }),
          runner.call("runner.health", {}, { signal }),
        ])
          .then(([description, health]) => {
            options.onReady?.();
            log.info(
              {
                pid,
                build: description.build,
                sessions: health.sessions,
                memoryUsed: health.memoryUsed,
              },
              "Local runner answered describe and health"
            );
          })
          .catch((err: unknown) =>
            log.warn(
              { pid, err },
              "Local runner did not answer describe and health"
            )
          );
      } else if (state.state === "waiting") {
        runner.setEndpoint(null);
        log.warn(
          {
            reason: (state.error as { reason?: string }).reason,
            err: state.error.message,
            retryInMs: state.retryInMs,
          },
          "Local runner is not running; retrying"
        );
      }
    },
  });
  return {
    runner,
    get frozen() {
      return fence.wanted;
    },
    activity: fence.activity,
    freeze: fence.freeze,
    async thaw() {
      await fence.thaw();
      const child =
        supervisor.state.state === "ready" ? supervisor.state.runner : null;
      if (child) void importBindings(child);
    },
    frozenSessions: fence.frozenSessions,
    async stop(graceMs = 3_000) {
      runner.close();
      await supervisor.stop(graceMs);
    },
  };
}

export function localTerminal(
  child: (() => Runner | undefined) | undefined,
  agent: CheckoutSession
) {
  return typedTerminal(async () => {
    const runner = child?.();
    if (!runner) throw new Error("The session runner is unavailable.");
    return runner.open("terminal.open", {
      target: {
        path: pathFromWire(
          agent.workspacePath ?? agent.worktreePath ?? agent.cwd
        ),
      },
      cols: 80,
      rows: 24,
    });
  });
}

/** The adapter owns target routing and disconnected-inventory presentation. */
export function scopedEngineCalls(
  local: RunnerEngineCalls,
  remote:
    | {
        callEngine<K extends EngineHostCallName>(
          runnerId: string,
          op: K,
          request: Req<K>
        ): Promise<Res<K>>;
        engineInventorySnapshot?(
          runnerId: string
        ): Res<"engine.list">["entries"] | undefined;
        lastEngineInventory?(
          runnerId: string
        ): Res<"engine.list">["entries"] | undefined;
      }
    | undefined,
  scope: EngineScope,
  liveInventory = false
): RunnerEngineCalls {
  if (scope.kind === "local") return local;
  const runnerId = scope.runnerId;
  return {
    settings: enrolledRunnerSettings(runnerId),
    call: async (op, request) => {
      if (!remote)
        throw new RunnerCallError({
          code: "unavailable",
          message: "The runner is unavailable.",
        });
      if (op === "engine.list" && !(request as Req<"engine.list">).refresh) {
        const cached = remote.engineInventorySnapshot?.(runnerId);
        if (cached) return { entries: cached } as Res<typeof op>;
      }
      try {
        return await remote.callEngine(runnerId, op, request);
      } catch (error) {
        if (
          liveInventory ||
          op !== "engine.list" ||
          !(error instanceof RunnerCallError) ||
          !["unavailable", "unknown_outcome", "fenced"].includes(error.code)
        )
          throw error;
        const last = remote.lastEngineInventory?.(runnerId);
        return {
          entries: last?.map((entry) => ({ ...entry, actions: [] })) ?? [],
          available: last !== undefined,
        } as Res<typeof op>;
      }
    },
  };
}

/** The legacy local identity is an alias of the controller runner. */
export function engineScopeForRunner(runnerId: string): EngineScope {
  return runnerId === runnerIdToWire(LOCAL_RUNNER_ID)
    ? { kind: "local" }
    : { kind: "runner", runnerId };
}
