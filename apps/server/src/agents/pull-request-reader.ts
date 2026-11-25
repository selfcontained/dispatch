import type { GitHubPullRequestObservation } from "@dispatch/runner-protocol";
import type { Runner } from "@dispatch/runner-protocol/contract";
import type { AgentPullRequest } from "@dispatch/shared";

const credentialContexts = new WeakMap<AgentPullRequest, string>();

export function pullRequestCredentialContext(pr: AgentPullRequest) {
  return credentialContexts.get(pr);
}

export function githubPullRequestTarget(url: string) {
  const canonical = githubPullRequestUrl(url);
  if (!canonical) return null;
  const [, owner, repo, , number] = new URL(canonical).pathname.split("/");
  return { owner, repo, number: Number(number) };
}

export function githubPullRequestUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const match = url.pathname.match(
      /^\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\/?$/
    );
    if (url.protocol !== "https:" || url.hostname !== "github.com" || !match)
      return null;
    return `https://github.com/${match[1].toLowerCase()}/${match[2].toLowerCase()}/pull/${BigInt(match[3]).toString()}`;
  } catch {
    return null;
  }
}

/**
 * A pull request as its tracking agent's runner reads it: one call for
 * every placement. A URL that is not a GitHub pull request, like a runner
 * that cannot answer, is an unavailable read.
 */
export function createRunnerPullRequestReader(
  runnerFor: (runnerId: string | null) => Pick<Runner, "call">
) {
  return async (
    url: string,
    title: string,
    runnerId: string | null
  ): Promise<AgentPullRequest> => {
    const canonical = githubPullRequestUrl(url);
    const target = canonical && githubPullRequestTarget(canonical);
    if (!canonical || !target) return { url, title, status: "Unavailable" };
    const observation = await runnerFor(runnerId).call(
      "github.pr.status",
      target
    );
    return projectPullRequest(canonical, title, observation);
  };
}

export {
  pullRequestQueryArgs,
  pullRequestObservation,
} from "@dispatch/runner-protocol/github-pr-observation";

export function projectPullRequest(
  url: string,
  title: string,
  observation: GitHubPullRequestObservation,
  observedAt?: number
): AgentPullRequest {
  const { state, draft, head, rollup, title: observedTitle } = observation;
  const status =
    state === "MERGED"
      ? "Merged"
      : state === "CLOSED"
        ? "Closed"
        : state === "OPEN"
          ? draft === true
            ? "Draft"
            : "Open"
          : "Unavailable";
  if (status === "Unavailable") return { url, title, status };
  const pr: AgentPullRequest = {
    url,
    status,
    title: typeof observedTitle === "string" ? observedTitle : title,
    ci: mapPullRequestChecks(head, rollup, observedAt),
  };
  if (observation.credentialContext)
    credentialContexts.set(pr, observation.credentialContext);
  return pr;
}

/** gh returns the current head rollup (CheckRun and StatusContext), not history. */
export function mapPullRequestChecks(
  head: unknown,
  rollup: unknown,
  observedAt = Date.now()
): NonNullable<AgentPullRequest["ci"]> {
  const ci: NonNullable<AgentPullRequest["ci"]> = {
    checkedAt: new Date(observedAt).toISOString(),
    headSha: typeof head === "string" ? head : "",
    availability: "unavailable",
    summary: {
      status: "none",
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      skipped: 0,
    },
    checks: [],
  };
  if (!ci.headSha || !Array.isArray(rollup) || rollup.length > 100) return ci;
  const checks = new Map<string, (typeof ci.checks)[number]>();
  const latest = new Map<string, number>();
  for (const raw of rollup) {
    if (!raw || typeof raw !== "object") return ci;
    const context = raw.__typename === "StatusContext";
    if (!context && raw.__typename !== "CheckRun") return ci;
    const name = context ? raw.context : raw.name;
    if (typeof name !== "string") return ci;
    const status = context
      ? raw.state === "PENDING" || raw.state === "EXPECTED"
        ? "PENDING"
        : "COMPLETED"
      : raw.status;
    if (typeof status !== "string") return ci;
    const conclusion = context
      ? status === "PENDING"
        ? null
        : raw.state === "ERROR"
          ? "FAILURE"
          : raw.state
      : raw.conclusion || null;
    if (conclusion !== null && typeof conclusion !== "string") return ci;
    const url = context ? raw.targetUrl : raw.detailsUrl;
    // Reruns replace earlier attempts of a job from the same provider. In
    // particular an earlier cancelled attempt must not fail a passing rerun.
    const key = `${raw.__typename}:${raw.checkSuite?.app?.slug ?? ""}:${raw.checkSuite?.workflowRun?.workflow?.id ?? ""}:${name}`;
    const attempt = typeof raw.databaseId === "number" ? raw.databaseId : 0;
    if ((latest.get(key) ?? -1) > attempt) continue;
    latest.set(key, attempt);
    checks.set(key, {
      identity: key,
      name,
      status,
      conclusion,
      detailsUrl:
        typeof url === "string" && /^https?:\/\//.test(url) ? url : null,
      startedAt:
        !context &&
        typeof raw.startedAt === "string" &&
        Number.isFinite(Date.parse(raw.startedAt))
          ? raw.startedAt
          : undefined,
      completedAt:
        !context &&
        typeof raw.completedAt === "string" &&
        Number.isFinite(Date.parse(raw.completedAt))
          ? raw.completedAt
          : undefined,
    });
  }
  ci.checks = [...checks.values()];
  for (const check of ci.checks) {
    ci.summary.total++;
    if (!check.conclusion) ci.summary.pending++;
    else if (check.conclusion === "SUCCESS") ci.summary.passed++;
    else if (["SKIPPED", "NEUTRAL"].includes(check.conclusion))
      ci.summary.skipped++;
    else ci.summary.failed++;
  }
  ci.availability = "available";
  ci.summary.status = ci.summary.failed
    ? "failing"
    : ci.summary.pending
      ? "pending"
      : ci.summary.total
        ? "passing"
        : "none";
  return ci;
}
