import {
  validBranch,
  isGitHubPullRequestTarget,
  validGitHubRepoPart,
  type RepositoryCheckout,
} from "@dispatch/runner-protocol";
import {
  assertSafeRefName,
  normalizeBaseBranch,
} from "../shared/git/worktree.js";
import type { WorktreeRequest } from "./workspace-launch.js";

export type CheckoutIntent = {
  useWorktree?: boolean;
  createNewBranch?: boolean;
  worktreeBranch?: string;
  baseBranch?: string;
  /** Open this pull request's source branch: a GitHub PR URL or number. */
  pullRequest?: string;
};

export type PullRequestTarget = { owner: string; repo: string; number: number };
/** The PR's source: the head repository clone URL and branch. */
export type PullRequestHead = { url: string; branch: string };
export type PullRequestHeadLookup = (
  target: PullRequestTarget
) => Promise<PullRequestHead>;

export class CheckoutIntentError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400
  ) {
    super(message);
    this.name = "CheckoutIntentError";
  }
}

/** Owner and name of a GitHub repository URL, compared case-insensitively. */
export function githubRepository(
  url: string | undefined
): { owner: string; repo: string } | null {
  const match =
    url &&
    /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url);
  if (!match) return null;
  const [, owner, repo] = match;
  return validGitHubRepoPart(owner) && validGitHubRepoPart(repo)
    ? { owner, repo }
    : null;
}

function sameRepository(
  a: { owner: string; repo: string },
  b: { owner: string; repo: string }
) {
  return (
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.repo.toLowerCase() === b.repo.toLowerCase()
  );
}

/** A PR URL must name the launch repository; a bare number refers to it. */
export function pullRequestTarget(
  source: string,
  repository: string | undefined
): PullRequestTarget {
  const repo = githubRepository(repository);
  if (!repo)
    throw new CheckoutIntentError(
      "Opening a pull request needs a GitHub repository."
    );
  const value = source.trim();
  const number = /^#?([1-9][0-9]{0,9})$/.exec(value);
  if (number) return { ...repo, number: Number(number[1]) };
  const url =
    /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9][0-9]{0,9})\/?$/i.exec(
      value
    );
  const target = url && { owner: url[1], repo: url[2], number: Number(url[3]) };
  if (!isGitHubPullRequestTarget(target))
    throw new CheckoutIntentError("Enter a GitHub pull request URL or number.");
  if (!sameRepository(target, repo))
    throw new CheckoutIntentError(
      "Choose a pull request from the selected repository."
    );
  return { ...repo, number: target.number };
}

export type ResolvedCheckout =
  | {
      createNewBranch: true;
      branch: string;
      base?: string;
      source: "branch" | "default";
    }
  | {
      createNewBranch: false;
      branch: string;
      base: string;
      source: "branch" | "default";
    }
  | {
      createNewBranch: false;
      branch: string;
      base: string;
      source: "pullRequest";
      /** Clone URL of the PR's head repository (a fork or the same one). */
      repository: string;
    }
  | {
      createNewBranch: false;
      branch?: undefined;
      base?: undefined;
      source: "default";
    };

export async function resolveCheckoutIntent(
  input: CheckoutIntent,
  {
    id,
    name,
    defaultBranch,
    repository,
    pullRequestHead,
    forkPullRequests = true,
  }: {
    id: string;
    name: string;
    defaultBranch?: () => Promise<string | undefined>;
    /** The launch repository's URL, needed only to open a pull request. */
    repository?: () => Promise<string | undefined>;
    pullRequestHead?: PullRequestHeadLookup;
    /** False when the executor can only check out branches of its origin. */
    forkPullRequests?: boolean;
  }
): Promise<{
  normalizedBaseBranch: string | undefined;
  checkout: ResolvedCheckout | null;
}> {
  if (input.pullRequest?.trim()) {
    if (input.useWorktree === false || input.createNewBranch === true)
      throw new CheckoutIntentError(
        "A pull request opens its own branch in a managed worktree."
      );
    if (input.baseBranch?.trim())
      throw new CheckoutIntentError(
        "Choose a branch or a pull request, not both."
      );
    const launchRepository = await repository?.();
    const target = pullRequestTarget(input.pullRequest, launchRepository);
    if (!pullRequestHead)
      throw new CheckoutIntentError(
        "Pull requests can’t be opened here. Enter the branch name.",
        409
      );
    const head = await pullRequestHead(target).catch(() => {
      throw new CheckoutIntentError(
        `Couldn’t find the source branch of pull request #${target.number}. Check the number and GitHub access.`,
        422
      );
    });
    const headRepository = githubRepository(head.url);
    if (!headRepository)
      throw new CheckoutIntentError("Invalid PR source.", 422);
    if (!forkPullRequests && !sameRepository(headRepository, target))
      throw new CheckoutIntentError(
        "This pull request comes from a fork. Open it on a runner.",
        422
      );
    const branch = normalizeBaseBranch(head.branch);
    return {
      normalizedBaseBranch: branch,
      checkout: {
        createNewBranch: false,
        branch,
        base: branch,
        source: "pullRequest",
        repository: head.url,
      },
    };
  }
  // Validate supplied refs even when the launch does not use a worktree.
  const requestedBase = input.baseBranch?.trim()
    ? normalizeBaseBranch(input.baseBranch)
    : undefined;
  const requestedBranch = input.worktreeBranch?.trim()
    ? assertSafeRefName(input.worktreeBranch, "worktreeBranch")
    : undefined;

  const useWorktree = input.useWorktree !== false;
  const base =
    requestedBase ?? (useWorktree ? await defaultBranch?.() : undefined);
  const source = requestedBase ? "branch" : "default";
  let checkout: ResolvedCheckout | null = null;
  if (useWorktree) {
    if (input.createNewBranch ?? true) {
      const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      checkout = {
        createNewBranch: true,
        branch: requestedBranch ?? `${id}/${slug || "work"}`,
        base,
        source,
      };
    } else {
      checkout = base
        ? { createNewBranch: false, branch: base, base, source }
        : { createNewBranch: false, source: "default" };
    }
  }
  return { normalizedBaseBranch: base, checkout };
}

export function toRunnerCheckout(intent: ResolvedCheckout): RepositoryCheckout {
  if (intent.createNewBranch)
    return {
      kind: "new",
      branch: intent.branch,
      ...(intent.base ? { base: intent.base } : {}),
    };
  // A PR opens its head branch exactly as the web used to send it.
  if (intent.source === "pullRequest")
    return { kind: "branch", branch: intent.branch };
  if (intent.branch)
    return { kind: "branch", branch: intent.branch, allowDefault: true };
  return { kind: "default" };
}

export function toLocalWorktreeRequest(
  intent: ResolvedCheckout,
  name: string,
  location?: WorktreeRequest["location"]
): WorktreeRequest {
  return {
    name,
    // Only a new-branch request uses this field during preparation.
    branch: intent.branch ?? "",
    createNewBranch: intent.createNewBranch,
    baseBranch: intent.base,
    location,
  };
}

/** Older runners and origins without GitHub metadata resolve the base at checkout. */
export async function runnerDefaultBranch(
  url: string,
  listBranches: (
    owner: string,
    repo: string
  ) => Promise<{ branches: string[]; defaultBranch?: string }>
): Promise<string | undefined> {
  const repo =
    /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url);
  if (!repo) return undefined;
  const result = await listBranches(repo[1]!, repo[2]!).catch(() => null);
  return validBranch(result?.defaultBranch) ? result.defaultBranch : undefined;
}
