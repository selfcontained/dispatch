import {
  validBranch,
  type RepositoryCheckout,
} from "@dispatch/runner-protocol";
import { localDefaultBranch } from "../shared/git/default-branch.js";
import {
  assertSafeRefName,
  normalizeBaseBranch,
} from "../shared/git/worktree.js";
import type { WorktreeRequest } from "./workspace.js";

export type CheckoutIntent = {
  useWorktree?: boolean;
  createNewBranch?: boolean;
  worktreeBranch?: string;
  baseBranch?: string;
};

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
  }: {
    id: string;
    name: string;
    defaultBranch?: () => Promise<string | undefined>;
  }
): Promise<{
  normalizedBaseBranch: string | undefined;
  checkout: ResolvedCheckout | null;
}> {
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

export async function resolveLocalCheckout(
  cwd: string,
  request: Pick<WorktreeRequest, "branch" | "baseBranch" | "createNewBranch">
): Promise<{ branch: string; base: string }> {
  const base = request.baseBranch ?? (await localDefaultBranch(cwd));
  return { base, branch: request.createNewBranch ? request.branch : base };
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
