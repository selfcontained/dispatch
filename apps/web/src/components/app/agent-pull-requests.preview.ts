import type { PresentedPullRequest } from "./agent-pull-requests";

// Used only by the development-only ?pr-preview=1 view of the seeded demo agent.
const examples = [
  {
    status: "Open",
    title: "Show pull request status in session details",
    passed: 12,
    failed: 0,
    pending: 0,
    skipped: 0,
  },
  {
    status: "Open",
    title: "Refresh PR status on the server",
    passed: 8,
    failed: 2,
    pending: 3,
    skipped: 1,
  },
  {
    status: "Draft",
    title: "Add compact check summaries",
    passed: 0,
    failed: 0,
    pending: 3,
    skipped: 0,
  },
  {
    status: "Merged",
    title: "Align sidebar metadata",
    passed: 12,
    failed: 0,
    pending: 0,
    skipped: 0,
  },
] as const;
export const previewPullRequests: PresentedPullRequest[] = examples.map(
  (example, i) => ({
    url: `https://github.com/example/dispatch/pull/${1380 + i}`,
    title: example.title,
    status: example.status,
    ci: {
      checkedAt: new Date().toISOString(),
      headSha: "0123456789abcdef",
      availability: "available",
      summary: {
        status: example.failed
          ? "failing"
          : example.pending
            ? "pending"
            : "passing",
        total:
          example.passed + example.failed + example.pending + example.skipped,
        passed: example.passed,
        failed: example.failed,
        pending: example.pending,
        skipped: example.skipped,
      },
      checks: [
        {
          conclusion: "SUCCESS",
          count: example.passed,
          names: [
            "Typecheck",
            "Lint",
            "Build",
            "API integration",
            "Database migrations",
            "Accessibility",
            "Package smoke test",
            "Browser extension",
            "Linux build",
            "macOS build",
            "Windows build",
            "Install smoke test",
          ],
        },
        {
          conclusion: "FAILURE",
          count: example.failed,
          names: ["Unit tests", "Desktop E2E"],
        },
        {
          conclusion: null,
          count: example.pending,
          names: ["Mobile E2E", "Visual snapshots", "Compatibility"],
        },
        {
          conclusion: "SKIPPED",
          count: example.skipped,
          names: ["Release deployment"],
        },
      ].flatMap((group) =>
        Array.from({ length: group.count }, (_, n) => ({
          name: group.names[n],
          status: group.conclusion ? "COMPLETED" : "IN_PROGRESS",
          conclusion: group.conclusion,
          detailsUrl: null,
          startedAt:
            group.conclusion === "SKIPPED"
              ? undefined
              : new Date(Date.now() - (100 + n * 23) * 1000).toISOString(),
          completedAt:
            group.conclusion && group.conclusion !== "SKIPPED"
              ? new Date(Date.now() - 10_000).toISOString()
              : undefined,
        }))
      ),
    },
  })
);
