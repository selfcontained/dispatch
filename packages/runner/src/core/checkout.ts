/*
 * Checkout reads, commands and the binding read, served by the core. The core resolves
 * a request's target to a directory (a session's target only from the
 * runner's own binding, never from a path in the request) and hands the
 * work to the platform's workload. It never opens the directory itself.
 */
import {
  displayPath,
  pathFromWire,
  RunnerCallError,
  sessionToWire,
  type Res,
  type Target,
  type ReadTarget,
} from "@dispatch/runner-protocol/contract";
import { Duplex } from "node:stream";
import type { CallHandlers, OpenHandlers } from "../handlers.js";
import type { BindingStore, StoredBinding } from "../local/bindings.js";
import {
  EXEC_OPS,
  WORKER_OPS,
  WRITE_OPS,
  type Platform,
  type Selector,
  type WorkloadOp,
} from "../platform/types.js";

const notBound = () =>
  new RunnerCallError({
    code: "not_found",
    message: "No checkout is bound to this session",
  });

/** The directory a binding's selector names. */
function selected(
  binding: StoredBinding,
  selector: "current" | "launch" | "moved" | "owned" | undefined
): string {
  switch (selector) {
    case "launch":
    case "owned":
      return binding.checkout.path;
    case "moved":
      if (binding.currentPath === null) throw notBound();
      return binding.currentPath;
    default:
      return binding.currentPath ?? binding.checkout.path;
  }
}

/** A session target's directory, from the runner's own binding only. */
async function boundDirectory(
  store: Pick<BindingStore, "get">,
  target: Target
): Promise<string> {
  if (!("session" in target))
    throw new RunnerCallError({
      code: "unsupported",
      message: "This runner watches the checkouts it holds",
    });
  const binding = await store.get(sessionToWire(target.session));
  if (!binding) throw notBound();
  return selected(binding, target.checkout);
}

/**
 * `checkout.watch`: one byte on the channel per burst of changes in the
 * bound checkout, as the workload sees them; the channel ends when the
 * watch does. Closing it stops the watch.
 */
export function checkoutOpens(
  store: Pick<BindingStore, "get">,
  platform: Platform
): OpenHandlers {
  const { watch } = platform.workload;
  if (!watch) return {};
  return {
    async "checkout.watch"({ target }) {
      const directory = await boundDirectory(store, target);
      let stop = () => {};
      const channel = new Duplex({
        allowHalfOpen: false,
        read() {},
        write(_chunk, _encoding, callback) {
          callback(); // A pulse from the caller carries no meaning.
        },
        final(callback) {
          channel.destroy();
          callback();
        },
        destroy(error, callback) {
          stop();
          callback(error);
        },
      });
      stop = watch.call(
        platform.workload,
        directory,
        () => {
          if (!channel.destroyed) channel.push(PULSE);
        },
        () => {
          if (!channel.destroyed) channel.push(null);
        }
      );
      if (channel.destroyed) stop();
      return { info: {}, channel };
    },
  };
}

const PULSE = Buffer.from("1");

export function checkoutHandlers(
  store: Pick<BindingStore, "get" | "origin">,
  platform: Platform,
  /**
   * The cached clone of a repository, as a launch from it uses
   * (`repositoryClone`). Without it, repository targets are unsupported.
   */
  repositoryClone?: (url: string) => Promise<string>
): CallHandlers {
  async function directory(
    target: Target | ReadTarget,
    op?: string
  ): Promise<string> {
    if ("session" in target) {
      const binding = await store.get(sessionToWire(target.session));
      if (!binding) throw notBound();
      return selected(binding, target.checkout);
    }
    if ("path" in target) return displayPath(target.path);
    // A repository's default-branch files, from its cached clone: what main's
    // persona catalog reads from the origin's default branch.
    if (repositoryClone && op === "checkout.defaultFiles")
      return repositoryClone(target.repository);
    throw new RunnerCallError({
      code: "unsupported",
      message:
        "This runner reads checkouts it holds or paths, not repositories",
    });
  }

  const handlers: CallHandlers = {
    async "git.origin"(input) {
      return platform.workload.run(
        "git.origin",
        { directory: input.path, request: input },
        {}
      );
    },
    async "workspace.describe"({ session }) {
      const binding = await store.get(sessionToWire(session));
      if (!binding) throw notBound();
      const path = selected(binding, "current");
      const { checkout } = binding;
      const described: Res<"workspace.describe"> = {
        path: pathFromWire(path),
        moved: binding.currentPath !== null,
        origin: await store.origin(path),
        checkoutRoot: pathFromWire(checkout.path),
        worktree:
          checkout.ownership === "owned" && checkout.branch !== null
            ? {
                path: pathFromWire(checkout.path),
                branch: checkout.branch,
                base: checkout.base,
              }
            : null,
      };
      return described;
    },
  };
  handlers["git.context"] = async ({ target }) => {
    if (!("session" in target))
      return platform.workload.run(
        "git.context",
        {
          directory: await directory(target),
          request: {},
        },
        {}
      );
    const binding = await store.get(sessionToWire(target.session));
    if (!binding) throw notBound();
    const dir = selected(binding, target.checkout);
    const checkoutBranch =
      target.checkout !== "moved" &&
      (target.checkout === "launch" || binding.currentPath === null)
        ? (binding.checkout.branch ?? undefined)
        : undefined;
    return platform.workload.run(
      "git.context",
      {
        directory: dir,
        request: {},
        checkoutBranch,
      },
      {}
    );
  };
  for (const op of [
    ...WORKER_OPS.filter((op) => op !== "git.context" && op !== "git.origin"),
    ...EXEC_OPS,
    ...WRITE_OPS,
  ]) {
    const run = async (input: { target: Target | ReadTarget }) => {
      const { target, ...request } = input;
      // A write lands only in a checkout this runner's own binding names.
      if (
        (WRITE_OPS as readonly string[]).includes(op) &&
        !("session" in target)
      )
        throw new RunnerCallError({
          code: "unsupported",
          message: "This runner writes in the checkouts it holds",
        });
      const dir = await directory(target, op);
      const requested = "session" in target ? target.checkout : undefined;
      const selector: Selector =
        requested === "owned" ? "launch" : (requested ?? "current");
      const command = (EXEC_OPS as readonly string[]).includes(op);
      try {
        return await platform.workload.run(
          op as WorkloadOp,
          (command
            ? { directory: dir, request, selector }
            : { directory: dir, request }) as never,
          {}
        );
      } catch (error) {
        if (error instanceof RunnerCallError) throw error;
        throw new RunnerCallError({
          code: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };
    (handlers as Record<string, unknown>)[op] = run;
  }
  return handlers;
}
