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

export function parseGhJson<T>(stdout: string): T {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("GitHub CLI returned empty output");
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    throw new Error("Failed to parse GitHub CLI output");
  }
}

export function compareSemver(a: string, b: string): number {
  const parse = (v: string) =>
    v.replace(/^v/, "").split("-")[0]!.split(".").map(Number);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function currentReleaseBinaryGlob(): string {
  const platform =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "linux"
        ? "linux"
        : null;
  if (!platform) {
    throw new Error(
      `Unsupported platform for Bun release binary: ${process.platform}`
    );
  }

  const arch =
    process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  if (!arch) {
    throw new Error(
      `Unsupported architecture for Bun release binary: ${process.arch}`
    );
  }

  return `dist/bun/dispatch-*-bun-${platform}-${arch}`;
}

export function defaultServiceRestartCommand(): string {
  return process.platform === "linux"
    ? "systemctl --user restart dispatch"
    : "launchctl kickstart -k gui/$(id -u)/com.dispatch.server";
}

export async function getGitHubRepo(
  runCommand: RunCommand,
  serverDir: string
): Promise<string> {
  try {
    const result = await runCommand("git", [
      "-C",
      serverDir,
      "remote",
      "get-url",
      "origin",
    ]);
    const url = result.stdout;
    const match = url.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
    if (match?.[1]) {
      return match[1];
    }
  } catch {}
  return "selfcontained/dispatch";
}

export function createCheckIsAdmin(
  runCommand: RunCommand,
  serverDir: string
): () => Promise<boolean> {
  let cached: boolean | null = null;
  return async () => {
    const canCacheResult = process.env.VITEST !== "true";
    if (canCacheResult && cached !== null) return cached;
    try {
      await runCommand("gh", ["--version"]);
      const repo = await getGitHubRepo(runCommand, serverDir);
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
  runCommand: RunCommand,
  serverDir: string,
  tag: string
): Promise<GitHubReleaseMetadata | null> {
  try {
    const repo = await getGitHubRepo(runCommand, serverDir);
    const result = await runCommand("gh", [
      "release",
      "view",
      tag,
      "--repo",
      repo,
      "--json",
      "tagName,publishedAt,url,body",
    ]);
    const data = JSON.parse(result.stdout) as {
      tagName: string;
      publishedAt: string;
      url: string;
      body?: string | null;
    };
    return {
      tag: data.tagName,
      publishedAt: data.publishedAt,
      url: data.url,
      body: typeof data.body === "string" ? data.body.trim() : null,
    };
  } catch {
    return null;
  }
}
