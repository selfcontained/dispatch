import {
  isGitHubOperation,
  type GitHubOperation,
} from "@dispatch/runner-protocol";
import {
  ENGINE_HOST_CALLS,
  type EngineHostCallName,
} from "@dispatch/runner-protocol/engine-management";
import {
  RunnerCallError,
  operations,
  displayPath,
  type Req,
  type Res,
  type CallName,
} from "@dispatch/runner-protocol/contract";
import type { CallHandlers } from "../../../handlers.js";
import type { GitHubRunnerExecutor } from "./github-runner-executor.js";
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

/** The workload executor owns CLI credentials and serializes changes to its account. */
export function enrolledGitHubCalls(
  executor: Pick<GitHubRunnerExecutor, "handle">,
  signal: AbortSignal
) {
  async function run<K extends Extract<CallName, `github.${string}`>>(
    op: K,
    action: GitHubOperation
  ): Promise<Res<K>> {
    if (!isGitHubOperation(action))
      throw new RunnerCallError({
        code: "invalid",
        message: "Invalid runner command.",
      });
    let value: unknown;
    try {
      value = await executor.handle(action, signal);
    } catch {
      throw new RunnerCallError({
        code: "failed",
        message: "Runner GitHub operation failed.",
      });
    }
    if (!operations[op].response.check(value))
      throw new RunnerCallError({
        code: "failed",
        message: "Invalid runner GitHub response.",
      });
    return value as Res<K>;
  }
  return {
    "github.account": () => run("github.account", { type: "status" }),
    "github.login.start": () => run("github.login.start", { type: "login" }),
    "github.login.cancel": () => run("github.login.cancel", { type: "cancel" }),
    "github.logout": () => run("github.logout", { type: "logout" }),
    "github.repositories": ({ query }) =>
      run("github.repositories", { type: "repositorySearch", query }),
    "github.branches": ({ owner, repo }) =>
      run("github.branches", { type: "repositoryBranches", owner, repo }),
    "github.pr.head": ({ cwd, ...pr }) =>
      run(
        "github.pr.head",
        cwd === undefined
          ? { type: "pullRequestHead", ...pr }
          : { type: "pullRequestHeadAtPath", ...pr, cwd: displayPath(cwd) }
      ),
    "github.pr.status": (pr) =>
      run("github.pr.status", {
        type: "pullRequestStatus",
        ...pr,
        withCredentialContext: true,
      }),
    "github.pr.details": (pr) =>
      run("github.pr.details", { type: "pullRequestDetails", ...pr }),
    "github.pr.diff": ({ context, base, ...pr }) =>
      context === undefined || base === undefined
        ? null
        : run("github.pr.diff", {
            type: "pullRequestDiff",
            ...pr,
            base,
            credentialContext: context,
          }),
  } satisfies CallHandlers;
}
