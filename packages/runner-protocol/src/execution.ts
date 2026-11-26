import { validBranch } from "./checkout.js";

/** Inline first-text budget; larger launches use a private file. */
export const MAX_INLINE_FIRST_TEXT_BYTES = 64 * 1024;

export const RUNNER_WIRE_VERSION = 1;

export type RunnerEngine = "claude" | "codex" | "opencode";

export type ServiceMcp = {
  url: string;
  token: string;
  /** Legacy launchers omit the name and use "dispatch". */
  name?: string;
};

export type RepositoryCheckout =
  | { kind: "new"; branch: string; base?: string }
  | { kind: "branch"; branch: string; allowDefault?: true }
  | { kind: "default" }
  | { kind: "pr"; branch: string; number: number };

export type RunnerRepository = { url: string; checkout: RepositoryCheckout };

/** The guest supplies all machine-local execution settings. */
export type RemoteLaunch = {
  agentId: string;
  engine: RunnerEngine;
  fullAccess?: boolean;
  model: string | null;
  effort?: string | null;
  systemPrompt: string | null;
  personaContext?: string | null;
  mcp?: ServiceMcp;
  resumeSessionId: string | null;
  /** Durable identity used to reconcile the same launch after an update. */
  launchId?: string;
  /** Controller that owns this launch. */
  owner?: string;
};

export type SessionLifecycleOperation = { agentId: string } & (
  | { kind: "launch"; launch: RemoteLaunch }
  | { kind: "attach" | "alive" | "discard" | "log" }
  | {
      kind: "stop";
      force: boolean;
      expectedLaunchId?: string;
      expectedOwner?: string;
    }
);

export type GitQueryName =
  | "git.defaultBranch"
  | "git.branches"
  | "git.base"
  | "git.origin"
  | "git.roots";
export type ChannelFrame =
  | { type: "data"; id: string; data: string }
  | { type: "close"; id: string };

export type LaunchProgress =
  | { phase: "workspace" | "copy" | "dependencies" | "ready" }
  | { phase: "dependencies"; status: "done" | "failed"; detail?: string };

/** Check the URL before a runner makes any workspace changes. */
export function parseRunnerRepositoryUrl(
  source: unknown,
  fromOrigin = false
): URL | null {
  if (
    typeof source !== "string" ||
    !source.startsWith("https://") ||
    source.length > 2048 ||
    /[\s\\?#\x00-\x1f\x7f]/.test(source)
  )
    return null;
  try {
    const url = new URL(source);
    return url.hostname &&
      url.pathname !== "/" &&
      !url.hash &&
      !url.search &&
      (fromOrigin || (!url.username && !url.password))
      ? url
      : null;
  } catch {
    return null;
  }
}

export function repositoryUrl(input: string, fromOrigin = false): string {
  let source = input;
  if (fromOrigin) {
    const ssh = /^(?:git@|ssh:\/\/git@)([\w.-]+)[:/]([\w./-]+)$/.exec(input);
    if (ssh) source = `https://${ssh[1]}/${ssh[2]}`;
  }
  const invalid = () =>
    new Error("Runner repositories require a credential-free HTTPS Git URL.");
  const url = parseRunnerRepositoryUrl(source, fromOrigin);
  if (!url) throw invalid();
  url.username = "";
  url.password = "";
  return url.href;
}

/** A project identifies the repository independently of the clone URL spelling. */
export function projectRepositoryUrl(
  input: string,
  fromOrigin = false
): string {
  const url = new URL(repositoryUrl(input, fromOrigin));
  url.pathname = url.pathname
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  return url.href;
}

export type RepositoryInput = { url?: string; checkout: RepositoryCheckout };
/**
 * A launch's repository: a raw checkout plan (older clients), or only the
 * origin, whose checkout comes from the launch's worktree intent.
 */
export type RepositoryTarget = { url?: string; checkout?: RepositoryCheckout };

export function parseRepositoryTarget(input: unknown): RepositoryTarget {
  if (input && typeof input === "object" && !("checkout" in input)) {
    if (!("url" in input) || input.url === undefined) return {};
    if (typeof input.url !== "string")
      throw new Error("Repository URL must be a string.");
    return { url: repositoryUrl(input.url) };
  }
  return parseRepository(input);
}

export function parseRepository(input: unknown): RepositoryInput {
  if (!input || typeof input !== "object" || !("checkout" in input))
    throw new Error("A runner repository requires a checkout.");
  let url: string | undefined;
  if ("url" in input && input.url !== undefined) {
    if (typeof input.url !== "string")
      throw new Error("Repository URL must be a string.");
    url = repositoryUrl(input.url);
  }
  const checkout = input.checkout;
  if (!checkout || typeof checkout !== "object" || !("kind" in checkout))
    throw new Error("A valid checkout branch is required.");
  if (checkout.kind === "default") {
    if ("branch" in checkout && checkout.branch !== undefined)
      throw new Error("A default checkout resolves its branch on the runner.");
    return { url, checkout: { kind: "default" } };
  }
  if (!("branch" in checkout) || !validBranch(checkout.branch))
    throw new Error("A valid checkout branch is required.");
  const { branch } = checkout;
  switch (checkout.kind) {
    case "new": {
      const base = "base" in checkout ? checkout.base : undefined;
      if (base !== undefined && !validBranch(base))
        throw new Error("The checkout base must be a valid branch name.");
      return { url, checkout: { kind: "new", branch, base } };
    }
    case "branch": {
      const allowDefault =
        "allowDefault" in checkout ? checkout.allowDefault : undefined;
      if (allowDefault !== undefined && allowDefault !== true)
        throw new Error("allowDefault must be true when provided.");
      return {
        url,
        checkout: {
          kind: "branch",
          branch,
          ...(allowDefault && { allowDefault }),
        },
      };
    }
    case "pr": {
      const number = "number" in checkout ? checkout.number : undefined;
      if (
        typeof number !== "number" ||
        !Number.isSafeInteger(number) ||
        number < 1
      )
        throw new Error("The pull request number must be a positive integer.");
      return { url, checkout: { kind: "pr", branch, number } };
    }
    default:
      throw new Error("Checkout kind must be new, branch, default, or pr.");
  }
}
