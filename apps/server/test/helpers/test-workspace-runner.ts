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
import { checkoutWorkload } from "./checkout-workload.js";
import { workspaceWorkload } from "../../src/agents/checkout-worker.js";
import { localLaunchSettings } from "../../src/agents/acp/launch-env.js";
import { localRunnerIn } from "./local-runner-child.js";

/** Direct manager tests keep their Git mocks in this process. The app
 * integration harness exercises the same handlers over the real socket.
 * Sessions (hosts) go to the child's own session family, run in process. */
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
          if (op.startsWith("session."))
            return sessions().call(op, request, opts);
          // Persona fixtures read their real temporary files through the same
          // native workload as the application, while retaining Git mocks.
          if (op === "checkout.list" || op === "checkout.read") {
            const read = request as Req<"checkout.list"> | Req<"checkout.read">;
            if (read.mode === "native" && "path" in read.target) {
              const { target, ...input } = read;
              return (await checkoutWorkload.run(
                op,
                { directory: target.path, request: input } as never,
                { signal: opts?.signal }
              )) as Res<K>;
            }
          }
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
