import { vi } from "vitest";
import type { Pool } from "pg";
import { RunnerCallError } from "@dispatch/runner-protocol/contract";
import type { RemoteRunnerService } from "../../src/agents/remote/service.js";
import { placementForRunner } from "../../src/runners/placement.js";

export const enrolledProject = "manager-runner-fixture";
export const enrolledTarget = (id: string) => ({
  cwd: "",
  projectId: enrolledProject,
  placement: placementForRunner(id),
});

export function seedEnrolledProject(pool: Pool) {
  return pool.query(
    "INSERT INTO projects (id,name,repository) VALUES ($1,'Runner','https://example.test/test/manager') ON CONFLICT DO NOTHING",
    [enrolledProject]
  );
}

/** An enrolled runner for tests of manager scheduling, where hosts are supplied separately. */
export function managerEnrolledRunner(
  options: {
    online?: () => boolean;
    seen?: () => boolean;
    checkout?: () => string | undefined;
  } = {}
) {
  const online = options.online ?? (() => true);
  const seen = options.seen ?? online;
  const refuseNext = new Map<string, () => Promise<void>>();
  const call = vi.fn(
    async (
      _runner: string,
      op: string,
      input: {
        session?: string;
        target?: { session?: string; checkout?: string };
        [key: string]: unknown;
      }
    ) => {
      const refusal = refuseNext.get(op);
      if (refusal) {
        refuseNext.delete(op);
        await refusal();
        throw new RunnerCallError({
          code: "fenced",
          message: "The runner is updating.",
        });
      }
      const directory = options.checkout?.();
      if (
        directory &&
        (op === "checkout.list" || op === "checkout.read") &&
        input.mode !== "command-manifest"
      ) {
        const { target, ...request } = input;
        const { checkoutWorkload } = await import("./checkout-workload.js");
        return checkoutWorkload.run(op, { directory, request } as never, {});
      }
      switch (op) {
        case "workspace.prepare":
        case "workspace.resume":
        case "workspace.describe":
          return {
            path: directory ?? "/runner/sessions/" + input.session,
            worktree: null,
            branch: null,
            moved: false,
            origin: null,
            git: null,
          };
        case "git.context":
          return null;
        case "checkout.read":
          return { data: null };
        case "workspace.observe":
          return {
            ownership: "none",
            owner: null,
            borrowers: [],
            checkout: null,
          };
        case "workspace.release":
          return { removed: true };
        case "files.put":
          return { path: "/runner/files/x" };
        default:
          throw new Error("Unexpected runner operation " + op);
      }
    }
  );
  const remote = {
    available: vi.fn(online),
    connectionEpoch: () => (online() ? 1 : undefined),
    lastConnectionEpoch: vi.fn(() => (seen() ? 1 : undefined)),
    permitsAgentMcp: () => seen(),
    originFor: () => "https://example.test",
    call,
    putFile: async (runner: string, session: string, name: string) =>
      ((await call(runner, "files.put", { session, name })) as { path: string })
        .path,
  } as unknown as RemoteRunnerService;
  return { remote, call, refuseNext };
}
