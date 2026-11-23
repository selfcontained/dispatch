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
} from "@dispatch/runner-protocol/contract";
import type { CallHandlers } from "../local/socket-server.js";
import type { BindingStore, StoredBinding } from "../local/bindings.js";
import {
  EXEC_OPS,
  WORKER_OPS,
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
  selector: "current" | "launch" | "moved" | undefined
): string {
  switch (selector) {
    case "launch":
      return binding.checkout.path;
    case "moved":
      if (binding.currentPath === null) throw notBound();
      return binding.currentPath;
    default:
      return binding.currentPath ?? binding.checkout.path;
  }
}

export function checkoutHandlers(
  store: Pick<BindingStore, "get" | "origin">,
  platform: Platform
): CallHandlers {
  async function directory(target: Target): Promise<string> {
    if ("session" in target) {
      const binding = await store.get(sessionToWire(target.session));
      if (!binding) throw notBound();
      return selected(binding, target.checkout);
    }
    if ("path" in target) return displayPath(target.path);
    throw new RunnerCallError({
      code: "unsupported",
      message:
        "This runner reads checkouts it holds or paths, not repositories",
    });
  }

  const handlers: CallHandlers = {
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
    ...WORKER_OPS.filter((op) => op !== "git.context"),
    ...EXEC_OPS,
  ]) {
    const run = async (input: { target: Target }) => {
      const { target, ...request } = input;
      const dir = await directory(target);
      const selector: Selector =
        ("session" in target && target.checkout) || "current";
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
