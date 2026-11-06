import type { AgentPullRequest } from "@dispatch/shared";
import { runCommand, type CommandRunner } from "../shared/lib/run-command.js";

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

/** TTL and in-flight coalescing collapse duplicate scheduler requests. */
export function createPullRequestReader(run: CommandRunner = runCommand) {
  const cache = new Map<
    string,
    { expires: number; value: Promise<AgentPullRequest> }
  >();
  return (url: string, title: string): Promise<AgentPullRequest> => {
    const canonical = githubPullRequestUrl(url);
    const fallback: AgentPullRequest = { url, title, status: "Unavailable" };
    if (!canonical) return Promise.resolve(fallback);
    const cached = cache.get(canonical);
    if (cached && cached.expires > Date.now()) return cached.value;
    for (const [key, entry] of cache)
      if (entry.expires <= Date.now()) cache.delete(key);
    const value = (async (): Promise<AgentPullRequest> => {
      try {
        const [, owner, repo, , number] = new URL(canonical).pathname.split(
          "/"
        );
        const result = await run(
          "gh",
          [
            "api",
            "graphql",
            "-f",
            `query=${CHECKS_QUERY}`,
            "-f",
            `owner=${owner}`,
            "-f",
            `repo=${repo}`,
            "-F",
            `number=${number}`,
          ],
          { timeoutMs: 10_000, allowedExitCodes: [0, 1] }
        );
        const response = JSON.parse(result.stdout);
        const pr = response.data?.repository?.pullRequest;
        if (!pr) return fallback;
        const commit = pr.commits?.nodes?.[0]?.commit;
        const contexts = commit?.statusCheckRollup?.contexts;
        // A null rollup means no checks; partial/error/truncated data is unavailable.
        const rollup =
          !response.errors?.length && commit?.oid === pr.headRefOid
            ? commit.statusCheckRollup === null
              ? []
              : contexts && !contexts.pageInfo?.hasNextPage
                ? contexts.nodes
                : undefined
            : undefined;
        const status =
          pr.state === "MERGED"
            ? "Merged"
            : pr.state === "CLOSED"
              ? "Closed"
              : pr.state === "OPEN"
                ? pr.isDraft
                  ? "Draft"
                  : "Open"
                : "Unavailable";
        return {
          url: canonical,
          title: typeof pr.title === "string" ? pr.title : title,
          status,
          ci: mapPullRequestChecks(pr.headRefOid, rollup),
        };
      } catch {
        return fallback;
      }
    })();
    cache.set(canonical, { expires: Date.now() + 60_000, value });
    return value;
  };
}

const CHECKS_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      title state isDraft headRefOid
      commits(last: 1) { nodes { commit { oid statusCheckRollup {
        contexts(first: 100) { pageInfo { hasNextPage } nodes {
          __typename
          ... on CheckRun { databaseId name status conclusion detailsUrl checkSuite { app { slug } workflowRun { workflow { id } } } }
          ... on StatusContext { context state targetUrl }
        } }
      } } } }
    }
  }
}`;

/** gh returns the current head rollup (CheckRun and StatusContext), not history. */
export function mapPullRequestChecks(
  head: unknown,
  rollup: unknown
): NonNullable<AgentPullRequest["ci"]> {
  const ci: NonNullable<AgentPullRequest["ci"]> = {
    checkedAt: new Date().toISOString(),
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
  if (!ci.headSha || !Array.isArray(rollup)) return ci;
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
    const conclusion = context
      ? status === "PENDING"
        ? null
        : raw.state === "ERROR"
          ? "FAILURE"
          : raw.state
      : raw.conclusion || null;
    const url = context ? raw.targetUrl : raw.detailsUrl;
    // Reruns replace earlier attempts of a job from the same provider. In
    // particular an earlier cancelled attempt must not fail a passing rerun.
    const key = `${raw.__typename}:${raw.checkSuite?.app?.slug ?? ""}:${raw.checkSuite?.workflowRun?.workflow?.id ?? ""}:${name}`;
    const attempt = typeof raw.databaseId === "number" ? raw.databaseId : 0;
    if ((latest.get(key) ?? -1) > attempt) continue;
    latest.set(key, attempt);
    checks.set(key, {
      name,
      status,
      conclusion,
      detailsUrl:
        typeof url === "string" && /^https?:\/\//.test(url) ? url : null,
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
