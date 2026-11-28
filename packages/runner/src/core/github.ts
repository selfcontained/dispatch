import {
  isGitHubOperation,
  type GitHubOperation,
} from "@dispatch/runner-protocol";
import {
  RunnerCallError,
  operations,
  displayPath,
  type CallName,
  type Res,
} from "@dispatch/runner-protocol/contract";
/*
 * GitHub reads, served by the core from the platform's GitHub port. The
 * port runs them as the workload account; cadence and backoff are the
 * caller's policy.
 */
import type { CallHandlers } from "../handlers.js";
import type { Platform } from "../platform/types.js";

export function githubHandlers(
  platform: Platform,
  signal = new AbortController().signal
): CallHandlers {
  const { github } = platform;
  if (!github) return {};
  return {
    ...(github.management && githubExecutorCalls(github.management, signal)),
    ...(github.repositories && {
      "github.repositories": (request) => github.repositories!(request),
    }),
    "github.pr.head": (request) => github.pullRequestHead(request),
    "github.pr.status": (request) => github.pullRequestStatus(request, {}),
    "github.pr.details": (request) => github.pullRequestDetails(request, {}),
    "github.pr.diff": (request) => github.pullRequestDiff(request, {}),
  };
}

/** The workload executor owns CLI credentials and serializes changes to its account. */
export function githubExecutorCalls(
  executor: {
    handle(action: GitHubOperation, signal: AbortSignal): Promise<unknown>;
  },
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
