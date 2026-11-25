import { RunnerCallError, type Req, type Res } from "./contract/index.js";
import type { EngineHostCallName } from "./engine-management.js";
import type { AcpEngineId } from "./host.js";
type EngineCalls = {
  call<K extends EngineHostCallName>(op: K, input: Req<K>): Promise<Res<K>>;
};
type UpdateObserver = {
  output?: (chunk: string) => void;
  spawned?: (pid: number) => Promise<void>;
  closed?: () => void;
};
type CommandRunner = (
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    allowedExitCodes?: number[];
    timeoutMs?: number;
    trimOutput?: boolean;
  }
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export function createEngineUpdatePort(
  engines: EngineCalls,
  randomUUID: () => string,
  clearEngineVersionCache: () => void
) {
  return {
    clearEngineVersionCache,
    prepare: async (
      engine: "claude" | "codex" | "opencode",
      _overrides: Partial<Record<AcpEngineId, string>>,
      action: "install" | "update" = "update"
    ) => engines.call("engine.update.inspect", { engine, action }),
    verify: async (bin: string) =>
      (await engines.call("engine.update.probe", { pids: [], bin })).version,
    processExists: async (pid: number) => {
      try {
        return (
          (
            await engines.call("engine.update.probe", {
              pids: [Math.abs(pid)],
              groups: true,
            })
          ).alive[0] ?? true
        );
      } catch (error) {
        if (
          error instanceof RunnerCallError &&
          ["unavailable", "unknown_outcome", "not_found"].includes(error.code)
        )
          return true;
        throw error;
      }
    },
    runner:
      (observer: UpdateObserver): CommandRunner =>
      async (executable, args, options) => {
        const env =
          options?.env &&
          Object.fromEntries(
            Object.entries(options.env).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string"
            )
          );
        const operation = await engines.call("engine.update.spawn", {
          requestId: randomUUID(),
          command: { executable, args, ...(env && { env }) },
          timeoutMs: options?.timeoutMs ?? 120_000,
        });
        try {
          // The host is still blocked on stdin until this durable PID write commits.
          await observer.spawned?.(operation.pid);
        } catch (error) {
          await engines
            .call("engine.update.release", {
              operationId: operation.operationId,
              abort: true,
            })
            .catch(() => {});
          throw error;
        }
        let releaseError: unknown;
        const released = engines
          .call("engine.update.release", { operationId: operation.operationId })
          .catch((error: unknown) => {
            releaseError = error;
          });
        let offset = 0;
        while (true) {
          if (releaseError) throw releaseError;
          const state = await engines.call("engine.operation", {
            operationId: operation.operationId,
          });
          if (state.type !== "operation_state")
            throw new Error("Invalid engine process state.");
          if (state.outputOffset > offset)
            observer.output?.(
              state.output.slice(
                -Math.min(state.outputOffset - offset, state.output.length)
              )
            );
          offset = state.outputOffset;
          if (state.error) throw new Error(state.error);
          if (state.result) {
            await released;
            if (releaseError) throw releaseError;
            return state.result;
          }
          if (!state.running)
            throw new RunnerCallError({
              code: "unknown_outcome",
              message: "Engine process outcome is unavailable.",
            });
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      },
  };
}
