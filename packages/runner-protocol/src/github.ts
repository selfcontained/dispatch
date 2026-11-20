import { validBranch } from "./checkout.js";
import { isRecord } from "./validation.js";

export const githubDeviceUrl = "https://github.com/login/device";

export type GitHubPullRequestTarget = {
  owner: string;
  repo: string;
  number: number;
};

export const MAX_PULL_REQUEST_WATCH_TARGETS = 64;
export const MAX_PULL_REQUEST_WATCH_EVENT_BYTES = 1024 * 1024;

export type GitHubPullRequestWatchEvent =
  | { type: "reset" }
  | {
      type: "observation";
      target: GitHubPullRequestTarget;
      observedAt: number;
      observation: GitHubPullRequestObservation | null;
    };

export function parseGitHubPullRequestWatchEvent(
  value: unknown
): GitHubPullRequestWatchEvent | null {
  if (!isRecord(value)) return null;
  if (value.type === "reset") return { type: "reset" };
  if (
    value.type !== "observation" ||
    !isGitHubPullRequestTarget(value.target) ||
    !count(value.observedAt) ||
    value.observedAt > 8_640_000_000_000_000 ||
    (value.observation !== null &&
      !isGitHubPullRequestObservation(value.observation))
  )
    return null;
  return {
    type: "observation",
    target: value.target,
    observedAt: value.observedAt,
    observation: value.observation,
  };
}

export function githubPullRequestTargetKey(target: GitHubPullRequestTarget) {
  return `${target.owner.toLowerCase()}/${target.repo.toLowerCase()}/${target.number}`;
}

export type GitHubOperation =
  | { type: "watchPullRequests"; targets: GitHubPullRequestTarget[] }
  | { type: "status" | "login" | "cancel" | "logout" }
  | { type: "repositorySearch"; query: string }
  | { type: "repositoryBranches"; owner: string; repo: string }
  | (GitHubPullRequestTarget &
      (
        | { type: "pullRequestHead" | "pullRequestDetails" }
        | {
            type: "pullRequestStatus";
            withCredentialContext?: true;
            refreshWatch?: true;
          }
        | {
            type: "pullRequestDiff";
            base: string;
            head: string;
            credentialContext: string;
          }
      ));

export type GitHubChangedFile = {
  path: string;
  additions: number;
  deletions: number;
  patch?: string;
};

export type GitHubPullRequestDetails = {
  credentialContext: string;
  number: number;
  title: string;
  body: string;
  baseRefName: string;
  headRefName: string;
  baseRefOid: string;
  headRefOid: string;
  additions: number;
  deletions: number;
  files: GitHubChangedFile[];
};

export type GitHubPullRequestDiff = {
  files: GitHubChangedFile[];
};

export function validGitHubCommit(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

function validCredentialContext(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function boundedString(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length <= limit;
}

function validFile(value: unknown, diff: boolean): boolean {
  return (
    isRecord(value) &&
    boundedString(value.path, 4096) &&
    value.path.length > 0 &&
    count(value.additions) &&
    count(value.deletions) &&
    (value.patch === undefined || (diff && boundedString(value.patch, 32768)))
  );
}

export function isGitHubPullRequestDetails(
  value: unknown
): value is GitHubPullRequestDetails {
  return (
    isRecord(value) &&
    validCredentialContext(value.credentialContext) &&
    count(value.number) &&
    value.number > 0 &&
    boundedString(value.title, 1024) &&
    boundedString(value.body, 65536) &&
    boundedString(value.baseRefName, 1024) &&
    boundedString(value.headRefName, 1024) &&
    validGitHubCommit(value.baseRefOid) &&
    validGitHubCommit(value.headRefOid) &&
    count(value.additions) &&
    count(value.deletions) &&
    Array.isArray(value.files) &&
    value.files.length <= 100 &&
    value.files.every((file) => validFile(file, false))
  );
}

export function isGitHubPullRequestDiff(
  value: unknown
): value is GitHubPullRequestDiff {
  return (
    isRecord(value) &&
    Array.isArray(value.files) &&
    value.files.length <= 300 &&
    value.files.every((file) => validFile(file, true))
  );
}

/** Result of the fixed current-head query. An inaccessible PR has a null state.
 * An empty rollup is authoritative. A null rollup is incomplete or unavailable. */
export type GitHubPullRequestObservation = {
  state: "OPEN" | "CLOSED" | "MERGED" | null;
  draft: boolean;
  title: string | null;
  head: string | null;
  rollup: unknown[] | null;
  credentialContext?: string;
};

export function isGitHubPullRequestObservation(
  value: unknown
): value is GitHubPullRequestObservation {
  return (
    isRecord(value) &&
    (value.state === null ||
      value.state === "OPEN" ||
      value.state === "CLOSED" ||
      value.state === "MERGED") &&
    (value.credentialContext === undefined ||
      validCredentialContext(value.credentialContext)) &&
    typeof value.draft === "boolean" &&
    (value.title === null || typeof value.title === "string") &&
    (value.head === null || typeof value.head === "string") &&
    (value.rollup === null ||
      (Array.isArray(value.rollup) && value.rollup.length <= 100))
  );
}

export const githubCliMissing = "GitHub CLI is missing on this runner.";

// Only these diagnostics may pass from the runner into Settings. CLI output
// can contain an account token or a one-time device code.
export const githubAccountIssues = {
  missing: githubCliMissing,
  account:
    "GitHub CLI could not read the account for the runner’s workload user.",
  verify: "GitHub CLI could not verify the saved account with github.com.",
  network: "The runner could not connect to github.com.",
  device: "GitHub CLI exited before it returned a device code.",
  timeout: "GitHub CLI timed out waiting for a device code.",
  authorization:
    "GitHub device authorization did not finish. Start sign-in again.",
  helper:
    "GitHub sign-in succeeded, but configuring Git’s credential helper failed.",
  logout: "GitHub CLI could not sign out the workload account.",
} as const;

export function isGitHubAccountIssue(value: unknown): value is string {
  return Object.values(githubAccountIssues).some(
    (message) => message === value
  );
}

export type GitHubStatus =
  | { status: "signed-in"; login: string; gitIdentityUnavailable?: true }
  | { status: "pending"; code?: string; verificationUrl?: string }
  | { status: "signed-out" }
  | { status: "unavailable" | "failed"; message?: string };

export function validGitHubLogin(value: unknown): value is string {
  return (
    typeof value === "string" && /^[a-z\d](?:[a-z\d_-]{0,38})$/i.test(value)
  );
}

export function validGitHubDeviceCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(value);
}

export function validRepositorySearch(value: unknown): value is string {
  return (
    typeof value === "string" && /^[a-z\d_.-][a-z\d_./ -]{1,99}$/i.test(value)
  );
}

export function validGitHubRepoPart(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "." &&
    value !== ".." &&
    /^[a-z\d_.-]{1,100}$/i.test(value)
  );
}

export function isGitHubPullRequestTarget(
  value: unknown
): value is GitHubPullRequestTarget {
  return (
    isRecord(value) &&
    validGitHubRepoPart(value.owner) &&
    validGitHubRepoPart(value.repo) &&
    count(value.number) &&
    value.number > 0 &&
    value.number <= 9_999_999_999
  );
}

export function isGitHubOperation(value: unknown): value is GitHubOperation {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "status":
    case "login":
    case "cancel":
    case "logout":
      return true;
    case "watchPullRequests":
      return (
        Array.isArray(value.targets) &&
        value.targets.length > 0 &&
        value.targets.length <= MAX_PULL_REQUEST_WATCH_TARGETS &&
        value.targets.every(isGitHubPullRequestTarget)
      );
    case "repositoryBranches":
      return (
        validGitHubRepoPart(value.owner) && validGitHubRepoPart(value.repo)
      );
    case "repositorySearch":
      return validRepositorySearch(value.query);
    case "pullRequestStatus":
    case "pullRequestHead":
    case "pullRequestDetails":
    case "pullRequestDiff":
      return (
        (value.type !== "pullRequestStatus" ||
          ((value.withCredentialContext === undefined ||
            value.withCredentialContext === true) &&
            (value.refreshWatch === undefined ||
              value.refreshWatch === true))) &&
        (value.type !== "pullRequestDiff" ||
          (validGitHubCommit(value.base) &&
            validGitHubCommit(value.head) &&
            validCredentialContext(value.credentialContext))) &&
        isGitHubPullRequestTarget(value)
      );
    default:
      return false;
  }
}

export function parseGitHubRepositoryUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(value);
  return (
    !!match && validGitHubRepoPart(match[1]) && validGitHubRepoPart(match[2])
  );
}

export function githubRepositoryResults(value: unknown) {
  if (!Array.isArray(value)) throw new Error("Invalid GitHub repository list.");
  const repositories = value.slice(0, 12).flatMap((row) => {
    if (
      !isRecord(row) ||
      typeof row.name !== "string" ||
      !parseGitHubRepositoryUrl(row.url)
    )
      return [];
    const parts = row.name.split("/");
    return parts.length === 2 && parts.every(validGitHubRepoPart)
      ? [{ name: row.name, url: row.url }]
      : [];
  });
  return { repositories };
}

export function githubPullRequestHead(value: unknown) {
  if (
    isRecord(value) &&
    parseGitHubRepositoryUrl(value.url) &&
    validBranch(value.branch)
  ) {
    return { url: value.url, branch: value.branch };
  }
  throw new Error("GitHub pull request source branch is unavailable.");
}

export function parseGitHubStatus(value: unknown): GitHubStatus {
  if (isRecord(value)) {
    switch (value.status) {
      case "signed-in":
        if (validGitHubLogin(value.login))
          return {
            status: "signed-in",
            login: value.login,
            ...(value.gitIdentityUnavailable === true && {
              gitIdentityUnavailable: true,
            }),
          };
        break;
      case "pending":
        return value.verificationUrl === githubDeviceUrl &&
          validGitHubDeviceCode(value.code)
          ? {
              status: "pending",
              code: value.code,
              verificationUrl: githubDeviceUrl,
            }
          : { status: "pending" };
      case "signed-out":
        return { status: "signed-out" };
      case "unavailable":
      case "failed":
        return {
          status: value.status,
          ...(isGitHubAccountIssue(value.message)
            ? { message: value.message }
            : {}),
        };
    }
  }
  throw new Error("Invalid GitHub status.");
}
