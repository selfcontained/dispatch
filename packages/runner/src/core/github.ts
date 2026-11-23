/*
 * GitHub reads, served by the core from the platform's GitHub port. The
 * port runs them as the workload account; cadence and backoff are the
 * caller's policy.
 */
import type { CallHandlers } from "../local/socket-server.js";
import type { Platform } from "../platform/types.js";

export function githubHandlers(platform: Platform): CallHandlers {
  const { github } = platform;
  if (!github) return {};
  return {
    "github.pr.status": (request) => github.pullRequestStatus(request, {}),
  };
}
