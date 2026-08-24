import path from "node:path";

import { resolveConfiguredPath } from "../shared/lib/resolve-tilde.js";
// Re-exported for existing importers — the implementation lives in
// shared/lib so non-release code (plugin-status.ts) can use it without
// reaching into server/.
export { compareSemver } from "../shared/lib/compare-semver.js";

export type RunCommand = (
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: Record<string, string>;
    allowedExitCodes?: number[];
    timeoutMs?: number;
  }
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export type GitHubReleaseMetadata = {
  tag: string;
  publishedAt: string;
  url: string;
  body?: string | null;
};

export type GitHubReleaseListItem = {
  tag: string;
  publishedAt: string;
  url: string;
  prerelease: boolean;
  hasDispatchArtifact: boolean;
};

const DEFAULT_GITHUB_REPO = "selfcontained/dispatch";

export class GitHubApiError extends Error {
  constructor(readonly status: number) {
    super(`GitHub Releases request failed: ${status}`);
  }
}

export function isReleaseAuthoringEnabled(): boolean {
  return process.env.DISPATCH_RELEASE_AUTHORING === "1";
}

/**
 * Maintainer installs may run the server from a git-free runtime dir while
 * authoring releases from a separate checkout. Everything that inspects the
 * authoring repo (release job tag refresh, unreleased-commit enrichment)
 * must agree on which checkout that is.
 */
export function resolveAuthoringRepoDir(serverDir: string): string {
  const configured = process.env.DISPATCH_RELEASE_AUTHORING_REPO_DIR?.trim();
  return configured ? resolveConfiguredPath(configured) : serverDir;
}

export type AuthoringRemoteRefreshResult =
  | { ok: true }
  | { ok: false; error: unknown };

const DEFAULT_AUTHORING_FETCH_TTL_MS = 15_000;

/**
 * Single-flight + short-TTL guard around `git fetch` in the authoring
 * checkout. /release/info runs the fetch per admin request; without
 * coalescing, concurrent refreshes (multiple tabs, rapid clicks) contend
 * for git's ref locks and each spawns an up-to-30s network subprocess.
 * Concurrent callers share one in-flight fetch; callers within ttlMs of
 * the last completion reuse its result (success or failure alike, so a
 * broken remote isn't hammered either).
 */
export function createAuthoringRemoteRefresher(
  runCommand: RunCommand,
  options: { ttlMs?: number } = {}
): {
  refresh: (repoDir: string) => Promise<AuthoringRemoteRefreshResult>;
  reset: () => void;
} {
  const ttlMs = options.ttlMs ?? DEFAULT_AUTHORING_FETCH_TTL_MS;
  const entries = new Map<
    string,
    {
      promise: Promise<AuthoringRemoteRefreshResult>;
      completedAt: number | null;
    }
  >();
  return {
    refresh(repoDir: string) {
      const existing = entries.get(repoDir);
      if (
        existing &&
        (existing.completedAt === null ||
          Date.now() - existing.completedAt < ttlMs)
      ) {
        return existing.promise;
      }
      const entry: {
        promise: Promise<AuthoringRemoteRefreshResult>;
        completedAt: number | null;
      } = { promise: Promise.resolve({ ok: true }), completedAt: null };
      entry.promise = runCommand(
        "git",
        ["-C", repoDir, "fetch", "--quiet", "--tags", "origin", "main"],
        { timeoutMs: 30_000 }
      )
        .then((): AuthoringRemoteRefreshResult => ({ ok: true }))
        .catch(
          (error: unknown): AuthoringRemoteRefreshResult => ({
            ok: false,
            error,
          })
        )
        .finally(() => {
          entry.completedAt = Date.now();
        });
      entries.set(repoDir, entry);
      return entry.promise;
    },
    reset() {
      entries.clear();
    },
  };
}

/**
 * Release distribution must work from a source-less install. Keep the
 * repository explicit instead of probing a git remote owned by a different
 * user (or absent altogether).
 */
export async function getGitHubRepo(): Promise<string> {
  return process.env.DISPATCH_GITHUB_REPO?.trim() || DEFAULT_GITHUB_REPO;
}

export function parseGhJson<T>(stdout: string): T {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("GitHub CLI returned empty output");
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    throw new Error("Failed to parse GitHub CLI output");
  }
}

export function fixedRuntimePath(serverDir: string): string {
  const configured = process.env.DISPATCH_RUNTIME_PATH?.trim();
  return configured
    ? resolveConfiguredPath(configured)
    : path.join(serverDir, "dispatch");
}

export function defaultServiceRestartCommand(): string {
  return process.platform === "linux"
    ? "systemctl --user restart dispatch"
    : "launchctl kickstart -k gui/$(id -u)/com.dispatch.server";
}

export function createCheckIsAdmin(
  runCommand: RunCommand,
  serverDir: string
): () => Promise<boolean> {
  let cached: boolean | null = null;
  return async () => {
    if (!isReleaseAuthoringEnabled()) return false;
    const canCacheResult = process.env.VITEST !== "true";
    if (canCacheResult && cached !== null) return cached;
    try {
      await runCommand("gh", ["--version"]);
      const repo = await getGitHubRepo();
      const result = await runCommand("gh", [
        "repo",
        "view",
        repo,
        "--json",
        "viewerPermission",
        "--jq",
        ".viewerPermission",
      ]);
      const isAdmin = result.stdout.trim() === "ADMIN";
      if (canCacheResult) {
        cached = isAdmin;
      }
      return isAdmin;
    } catch {
      if (canCacheResult) {
        cached = false;
      }
      return false;
    }
  };
}

export async function fetchReleaseMetadata(
  tag: string
): Promise<GitHubReleaseMetadata | null> {
  try {
    const repo = await getGitHubRepo();
    const data = (await githubApi(
      `/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`
    )) as {
      tag_name: string;
      published_at: string;
      html_url: string;
      body?: string | null;
    };
    return {
      tag: data.tag_name,
      publishedAt: data.published_at,
      url: data.html_url,
      body: typeof data.body === "string" ? data.body.trim() : null,
    };
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) return null;
    throw error;
  }
}

export async function fetchGitHubReleases(): Promise<GitHubReleaseListItem[]> {
  const repo = await getGitHubRepo();
  const data = (await githubApi(
    `/repos/${repo}/releases?per_page=20`
  )) as Array<{
    tag_name: string;
    published_at: string;
    html_url: string;
    prerelease: boolean;
    assets?: Array<{ name: string }>;
  }>;
  return data.map((release) => ({
    tag: release.tag_name,
    publishedAt: release.published_at,
    url: release.html_url,
    prerelease: release.prerelease,
    hasDispatchArtifact:
      release.assets?.some(
        (asset) => asset.name === "dispatch-release.tar.gz"
      ) ?? false,
  }));
}

async function githubApi(pathname: string): Promise<unknown> {
  const token = process.env.GITHUB_TOKEN?.trim();
  const response = await fetch(`https://api.github.com${pathname}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "dispatch-release-runtime",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new GitHubApiError(response.status);
  }
  return response.json();
}
