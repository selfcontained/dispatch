import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  RunnerCallError,
  displayPath,
  type CallName,
  type CallOptions,
  type Req,
  type Res,
  type Runner,
} from "@dispatch/runner-protocol/contract";
import { workspaceHandlers } from "../../../../packages/runner/src/core/workspace.js";
import { BindingStore } from "../../../../packages/runner/src/local/bindings.js";
import type { AgentManager } from "../../src/agents/manager.js";
import { checkoutWorkload } from "./checkout-workload.js";
import { workspaceWorkload } from "../../../../packages/runner/src/workload/agents/checkout-worker.js";
import { localLaunchSettings } from "../../src/agents/acp/launch-env.js";
import { readLocalBindings } from "../../src/runners/local-bindings.js";
import { localRunnerIn } from "./local-runner-child.js";

/** Direct manager tests keep their Git mocks in this process. The app
 * integration harness exercises the same handlers over the real socket.
 * Sessions (hosts) go to the child's own session family, run in process. */
export function withTestWorkspaceRunner(
  Manager: typeof AgentManager,
  fixtureOptions: {
    /** DB decision tests use synthetic Git directories. Ownership is fixture data;
     * real import/identity checks are exercised by the real-child suites. */
    recordedArchiveFixture?: boolean;
  } = {}
) {
  return class extends Manager {
    constructor(
      ...[pool, log, config, options]: ConstructorParameters<typeof Manager>
    ) {
      super(pool, log, config, options);
      const directory = config.agentStateRoot;
      const store = new BindingStore(directory);
      const handlers = workspaceHandlers(directory, store, {
        ...workspaceWorkload,
        // These manager fixtures model a main-default repository.
        defaultBranch: async () => "main",
        async plan(spec) {
          return {
            path: join(directory, "mock-worktree"),
            branch: spec.branch,
            taken: false,
          };
        },
      });
      const unsupported = () =>
        new RunnerCallError({
          code: "unsupported",
          message: "Operation is outside the workspace fixture.",
        });
      const sessions = localRunnerIn(directory, localLaunchSettings(config));
      const runner: Runner & Pick<ReturnType<typeof sessions>, "openStream"> = {
        connection: { state: "ready", epoch: 0, onChange: () => () => {} },
        describe() {
          throw unsupported();
        },
        async open() {
          throw unsupported();
        },
        openStream: (op, request, opts) =>
          sessions().openStream(op, request, opts),
        async call<K extends CallName>(
          op: K,
          request: Req<K>,
          opts?: CallOptions<K>
        ): Promise<Res<K>> {
          if (
            fixtureOptions.recordedArchiveFixture &&
            (op === "workspace.observe" || op === "workspace.release")
          ) {
            const id = String((request as Req<"workspace.observe">).session);
            const { rows } = await pool.query<{
              id: string;
              worktree_path: string | null;
              worktree_branch: string | null;
              cwd: string;
            }>(
              "SELECT id, cwd, worktree_path, worktree_branch FROM agents WHERE id=$1",
              [id]
            );
            const row = rows[0];
            if (op === "workspace.observe") {
              const owner = row?.worktree_path
                ? row
                : (
                    await pool.query<typeof row>(
                      "SELECT id, cwd, worktree_path, worktree_branch FROM agents WHERE worktree_path=$1 AND (deleted_at IS NULL OR runner_cleanup_pending) ORDER BY id LIMIT 1",
                      [row?.cwd]
                    )
                  ).rows[0];
              const borrowers = owner?.worktree_path
                ? (
                    await pool.query<{ id: string }>(
                      `SELECT id FROM agents WHERE id <> $1 AND deleted_at IS NULL AND (cwd=$2 OR workspace_path=$2 OR worktree_path=$2) AND (worktree_path IS NOT NULL OR workspace_path=$2 OR NOT COALESCE(runner_preparation->'source' ? 'directory', false)) ORDER BY id`,
                      [owner.id, owner.worktree_path]
                    )
                  ).rows.map((r) => r.id)
                : [];
              return {
                ownership: !owner?.worktree_path
                  ? "external"
                  : owner.id === id
                    ? "owned"
                    : "borrowed",
                owner: owner?.worktree_path ? owner.id : null,
                borrowers,
                checkout:
                  owner?.worktree_path &&
                  !(request as Req<"workspace.observe">).policy
                    ? await workspaceWorkload.observe(owner.worktree_path)
                    : null,
              } as Res<K>;
            }
            return {
              removed:
                !row?.worktree_path ||
                (await workspaceWorkload.release(
                  id,
                  { path: row.worktree_path },
                  request as Req<"workspace.release">
                )),
            } as Res<K>;
          }
          if (op.startsWith("session.")) {
            const result = await sessions().call(op, request, opts);
            if (
              op === "session.retire" &&
              !(request as Req<"session.retire">).checkoutPending
            )
              await store.retire(
                String((request as Req<"session.retire">).session)
              );
            return result;
          }
          if (op === "workspace.observe" || op === "workspace.release")
            await store.import(await readLocalBindings(pool));
          // Persona fixture files use the same native workload as production.
          if (op === "checkout.list" || op === "checkout.read") {
            const read = request as Req<"checkout.list"> | Req<"checkout.read">;
            if (read.mode === "native" && "path" in read.target) {
              const { target, ...input } = read;
              return (await checkoutWorkload.run(
                op,
                {
                  directory: displayPath(target.path),
                  request: input,
                } as never,
                { signal: opts?.signal }
              )) as Res<K>;
            }
          }
          // Fixture Git mocks stay in process; production calls the runner port.
          if (op === "git.roots" || op === "checkout.defaultFiles") {
            const read = request as
              | Req<"git.roots">
              | Req<"checkout.defaultFiles">;
            if ("path" in read.target) {
              const { target, ...input } = read;
              return (await checkoutWorkload.run(
                op,
                {
                  directory: displayPath(target.path),
                  request: input,
                } as never,
                { signal: opts?.signal }
              )) as Res<K>;
            }
          }
          if (op === "git.defaultBranch")
            return { branch: "main", currentBranch: "main" } as Res<K>;
          if (op === "workspace.describe")
            throw new RunnerCallError({
              code: "not_found",
              message: "No checkout is served by this fixture.",
            });
          const handle = handlers[op];
          if (!handle) throw unsupported();
          await mkdir(directory, { recursive: true });
          return (await handle(request, {
            receiveBlob: async () => {
              throw unsupported();
            },
            emit: (event) => opts?.onEvent?.(event as never),
          })) as Res<K>;
        },
      };
      this.attachLocalRunner(() => runner);
    }
  };
}
