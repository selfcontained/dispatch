import {
  ENGINE_HOST_CALLS,
  type EngineHostCallName,
} from "@dispatch/runner-protocol/engine-management";
import type { Req } from "@dispatch/runner-protocol/contract";
import type { CallHandlers } from "../../../handlers.js";
import type { EngineRunnerExecutor } from "./engine-runner-executor.js";

export function enrolledEngineCalls(
  executor: Pick<EngineRunnerExecutor, "callHost">
): CallHandlers {
  const handler =
    <K extends EngineHostCallName>(op: K) =>
    (input: Req<K>) =>
      executor.callHost(op, input);
  return Object.fromEntries(ENGINE_HOST_CALLS.map((op) => [op, handler(op)]));
}

export { githubExecutorCalls as enrolledGitHubCalls } from "../../../core/github.js";
