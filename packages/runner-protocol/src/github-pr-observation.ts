import type { GitHubPullRequestObservation } from "./github.js";

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
