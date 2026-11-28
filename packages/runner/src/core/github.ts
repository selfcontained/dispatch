/*
 * GitHub reads, served by the core from the platform's GitHub port. The
 * port runs them as the workload account; cadence and backoff are the
 * caller's policy.
 */
import type { CallHandlers } from "../handlers.js";
import type { Platform } from "../platform/types.js";

export function githubHandlers(platform: Platform): CallHandlers {
  const { github } = platform;
  if (!github) return {};
  return {
    ...(github.repositories && {
      "github.repositories": (request) => github.repositories!(request),
    }),
    "github.pr.head": (request) => github.pullRequestHead(request),
    "github.pr.status": (request) => github.pullRequestStatus(request, {}),
    "github.pr.details": (request) => github.pullRequestDetails(request, {}),
    "github.pr.diff": (request) => github.pullRequestDiff(request, {}),
  };
}
