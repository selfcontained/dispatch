import { validBranch } from "./checkout.js";
import { isRecord } from "./validation.js";

export const githubDeviceUrl = "https://github.com/login/device";

export type GitHubOperation =
  | { type: "status" | "login" | "cancel" | "logout" }
  | { type: "repositorySearch"; query: string }
  | {
      type: "pullRequestHead" | "pullRequestStatus";
      owner: string;
      repo: string;
      number: number;
    };

/** Result of the fixed current-head query. An inaccessible PR has a null state.
 * An empty rollup is authoritative. A null rollup is incomplete or unavailable. */
export type GitHubPullRequestObservation = {
  state: "OPEN" | "CLOSED" | "MERGED" | null;
  draft: boolean;
  title: string | null;
  head: string | null;
  rollup: unknown[] | null;
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
    typeof value.draft === "boolean" &&
    (value.title === null || typeof value.title === "string") &&
    (value.head === null || typeof value.head === "string") &&
    (value.rollup === null ||
      (Array.isArray(value.rollup) && value.rollup.length <= 100))
  );
}

export type GitHubStatus =
  | { status: "signed-in"; login: string }
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

export function isGitHubOperation(value: unknown): value is GitHubOperation {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "status":
    case "login":
    case "cancel":
    case "logout":
      return true;
    case "repositorySearch":
      return validRepositorySearch(value.query);
    case "pullRequestStatus":
    case "pullRequestHead":
      return (
        validGitHubRepoPart(value.owner) &&
        validGitHubRepoPart(value.repo) &&
        typeof value.number === "number" &&
        Number.isSafeInteger(value.number) &&
        value.number > 0 &&
        value.number <= 9_999_999_999
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
          return { status: "signed-in", login: value.login };
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
        return { status: "unavailable" };
      case "failed":
        return { status: "failed" };
    }
  }
  throw new Error("Invalid GitHub status.");
}
