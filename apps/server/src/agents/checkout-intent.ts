import type { RepositoryCheckout } from "@dispatch/runner-protocol";
import { resolveCurrentBranch } from "../shared/git/git-context.js";
import {
  assertSafeRefName,
  normalizeBaseBranch,
} from "../shared/git/worktree.js";
import { detectDefaultBranch } from "./workspace-target.js";
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
  | { createNewBranch: false; branch: string; base: string; source: "branch" }
  | {
      createNewBranch: false;
      branch?: undefined;
      base?: undefined;
      source: "default";
    };

// Keep the current defaults here. Native preparation probes the checkout
// after verifying its source identity; runners resolve an omitted base.
const PLACEMENT_RULES = {
  local: {
    defaultBase: async (cwd: string) =>
      (await detectDefaultBranch(cwd)) ??
      (await resolveCurrentBranch(cwd).catch(() => null)) ??
      "main",
  },
  runner: {
    existingDefault: { kind: "default" } as const,
  },
};

export function resolveCheckoutIntent(
  input: CheckoutIntent,
  { id, name }: { id: string; name: string }
): {
  normalizedBaseBranch: string | undefined;
  checkout: ResolvedCheckout | null;
} {
  // Validate supplied refs even when the launch does not use a worktree.
  const base = input.baseBranch?.trim()
    ? normalizeBaseBranch(input.baseBranch)
    : undefined;
  const requestedBranch = input.worktreeBranch?.trim()
    ? assertSafeRefName(input.worktreeBranch, "worktreeBranch")
    : undefined;

  let checkout: ResolvedCheckout | null = null;
  if (input.useWorktree !== false) {
    if (input.createNewBranch ?? true) {
      const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      checkout = {
        createNewBranch: true,
        branch: requestedBranch ?? `${id}/${slug || "work"}`,
        base,
        source: base ? "branch" : "default",
      };
    } else {
      checkout = base
        ? { createNewBranch: false, branch: base, base, source: "branch" }
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
  if (intent.source === "branch")
    return { kind: "branch", branch: intent.branch, allowDefault: true };
  return PLACEMENT_RULES.runner.existingDefault;
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
  const base =
    request.baseBranch ?? (await PLACEMENT_RULES.local.defaultBase(cwd));
  return { base, branch: request.createNewBranch ? request.branch : base };
}
