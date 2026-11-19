import type { GitHubPullRequestObservation } from "@dispatch/runner-protocol";
import type { AgentPullRequest } from "@dispatch/shared";
import { runCommand, type CommandRunner } from "../shared/lib/run-command.js";

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

/** Bind the built-in and connected runner implementations at service startup.
 * A missing remote peer is an unavailable read for that placement. */
export function createRunnerPullRequestReader(
  remote:
    | {
        readPullRequest(
          runnerId: string,
          url: string,
          title: string,
          refreshWatch?: boolean
        ): Promise<AgentPullRequest>;
      }
    | undefined,
  readLocal = createPullRequestReader()
) {
  return async (
    url: string,
    title: string,
    runnerId: string | null,
    refreshWatch?: boolean
  ): Promise<AgentPullRequest> => {
    if (runnerId === null) return readLocal(url, title);
    if (!remote) return { url, title, status: "Unavailable" };
    return refreshWatch
      ? remote.readPullRequest(runnerId, url, title, true)
      : remote.readPullRequest(runnerId, url, title);
  };
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
          pullRequestQueryArgs(owner, repo, number),
          { timeoutMs: 10_000, allowedExitCodes: [0, 1] }
        );
        return projectPullRequest(
          canonical,
          title,
          pullRequestObservation(JSON.parse(result.stdout))
        );
      } catch {
        return fallback;
      }
    })();
    cache.set(canonical, { expires: Date.now() + 60_000, value });
    return value;
  };
}

export function pullRequestQueryArgs(
  owner: string,
  repo: string,
  number: string
) {
  return [
    "api",
    "graphql",
    "--hostname",
    "github.com",
    "-f",
    `query=${CHECKS_QUERY}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `repo=${repo}`,
    "-F",
    `number=${number}`,
  ];
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

/** Only the fields selected by the fixed query travel back to Dispatch. In
 * particular, gh diagnostics and the GraphQL errors array stay on the runner. */
export function pullRequestObservation(
  result: unknown
): GitHubPullRequestObservation {
  const response = record(result);
  const repository = record(record(response.data).repository);
  const pr = record(repository.pullRequest);
  const nodes = record(pr.commits).nodes;
  const commit = record(Array.isArray(nodes) && record(nodes[0]).commit);
  const contexts = record(record(commit.statusCheckRollup).contexts);
  const complete =
    (response.errors === undefined ||
      (Array.isArray(response.errors) && response.errors.length === 0)) &&
    typeof pr.headRefOid === "string" &&
    commit.oid === pr.headRefOid;
  return {
    state:
      pr.state === "OPEN" || pr.state === "CLOSED" || pr.state === "MERGED"
        ? pr.state
        : null,
    draft: pr.isDraft === true,
    title: typeof pr.title === "string" ? pr.title : null,
    head: typeof pr.headRefOid === "string" ? pr.headRefOid : null,
    rollup:
      complete && commit.statusCheckRollup === null
        ? []
        : complete &&
            record(contexts.pageInfo).hasNextPage === false &&
            Array.isArray(contexts.nodes) &&
            contexts.nodes.length <= 100
          ? contexts.nodes
          : null,
  };
}

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

const CHECKS_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      title state isDraft headRefOid
      commits(last: 1) { nodes { commit { oid statusCheckRollup {
        contexts(first: 100) { pageInfo { hasNextPage } nodes {
          __typename
          ... on CheckRun { databaseId name status conclusion detailsUrl startedAt completedAt checkSuite { app { slug } workflowRun { workflow { id } } } }
          ... on StatusContext { context state targetUrl }
        } }
      } } } }
    }
  }
}`;

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
