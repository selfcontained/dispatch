import type { AgentPullRequest } from "@dispatch/shared";
import { runCommand, type CommandRunner } from "../shared/lib/run-command.js";

export function githubPullRequestUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const match = url.pathname.match(
      /^\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\/?$/
    );
    if (url.protocol !== "https:" || url.hostname !== "github.com" || !match)
      return null;
    return `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`;
  } catch {
    return null;
  }
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
        const result = await run(
          "gh",
          ["pr", "view", canonical, "--json", "title,state,isDraft"],
          { timeoutMs: 10_000 }
        );
        const pr = JSON.parse(result.stdout);
        const status =
          pr.state === "MERGED"
            ? "Merged"
            : pr.state === "CLOSED"
              ? "Closed"
              : pr.state === "OPEN"
                ? pr.isDraft
                  ? "Draft"
                  : "Open"
                : "Unavailable";
        return {
          url: canonical,
          title: typeof pr.title === "string" ? pr.title : title,
          status,
        };
      } catch {
        return fallback;
      }
    })();
    cache.set(canonical, { expires: Date.now() + 60_000, value });
    return value;
  };
}
