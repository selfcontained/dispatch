import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  RunnerCallError,
  type CallName,
  type CallOptions,
  type Req,
  type Res,
  type Runner,
} from "@dispatch/runner-protocol/contract";
import { workspaceHandlers } from "../../../../packages/runner/src/core/workspace.js";
import { BindingStore } from "../../../../packages/runner/src/local/bindings.js";
import type { AgentManager } from "../../src/agents/manager.js";
import { workspaceWorkload } from "../../src/agents/checkout-worker.js";

/** Direct manager tests keep their Git mocks in this process. The app
 * integration harness exercises the same handlers over the real socket. */
export function withTestWorkspaceRunner(Manager: typeof AgentManager) {
  return class extends Manager {
    constructor(
      ...[pool, log, config, options]: ConstructorParameters<typeof Manager>
    ) {
      super(pool, log, config, options);
      const directory = config.agentStateRoot;
      const handlers = workspaceHandlers(
        directory,
        new BindingStore(directory),
        {
          ...workspaceWorkload,
          async plan(spec) {
            return {
              path: join(directory, "mock-worktree"),
              branch: spec.branch,
              taken: false,
            };
          },
        }
      );
      const unsupported = () =>
        new RunnerCallError({
          code: "unsupported",
          message: "Operation is outside the workspace fixture.",
        });
      const runner: Runner = {
        connection: { state: "ready", epoch: 0, onChange: () => () => {} },
        describe() {
          throw unsupported();
        },
        async open() {
          throw unsupported();
        },
        async call<K extends CallName>(
          op: K,
          request: Req<K>,
          opts?: CallOptions<K>
        ): Promise<Res<K>> {
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
