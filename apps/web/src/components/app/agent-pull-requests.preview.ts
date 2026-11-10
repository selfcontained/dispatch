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
    passed: 12,
    failed: 0,
    pending: 0,
    skipped: 0,
  },
] as const;
const previewMergeRisk: PresentedPullRequest["mergeRisk"][] = [
  {
    verdict: "routine",
    changeRisk: 1.1,
    changeRiskLabel: "moderate",
    reviewAdequate: 0.94,
    descriptionMatches: 0.97,
    newSurface: 0.08,
    routineProbability: 0.88,
    humanReviewProbability: 0.12,
    confidence: 0.86,
    status: "ok",
    promptVersion: "merge-risk-v2",
    headSha: "0123456789abcdef",
    assessedAt: new Date(Date.now() - 600_000).toISOString(),
  },
  {
    verdict: "human_review",
    changeRisk: 2.3,
    changeRiskLabel: "high",
    reviewAdequate: 0.91,
    descriptionMatches: 0.41,
    newSurface: 0.93,
    routineProbability: 0.2,
    humanReviewProbability: 0.8,
    confidence: 0.9,
    status: "ok",
    promptVersion: "merge-risk-v2",
    headSha: "0123456789abcdef",
    assessedAt: new Date(Date.now() - 300_000).toISOString(),
  },
];
export const previewPullRequests: PresentedPullRequest[] = examples.map(
  (example, i) => ({
    url: `https://github.com/example/dispatch/pull/${1380 + i}`,
    title: `Synthetic fixture · ${i === 0 ? "routine" : "read before merge"}`,
    status: example.status,
    ...(previewMergeRisk[i] ? { mergeRisk: previewMergeRisk[i] } : {}),
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

// Synthetic lifecycle fixtures, never provider-backed. Development preview only.
const fixtureBase = previewPullRequests[0];
const prior = {
  ...previewMergeRisk[0]!,
  headSha: "a1b2c3d4e5f678901234567890abcdef123456789",
};
for (const [i, displayState] of (
  [
    "not_ready",
    "waiting_ci",
    "waiting_review",
    "evaluating",
    "daily_cap",
    "capacity",
    "rate_limited",
    "failure",
    "unavailable",
    "disabled",
  ] as const
).entries()) {
  previewPullRequests.push({
    ...fixtureBase,
    url: `https://github.com/example/dispatch/pull/${1400 + i}`,
    title: `Synthetic fixture · ${displayState.replaceAll("_", " ")}`,
    ...(displayState === "waiting_ci"
      ? {
          ci: {
            ...fixtureBase.ci!,
            summary: {
              ...fixtureBase.ci!.summary,
              status: "pending" as const,
              pending: 1,
              passed: 11,
            },
          },
        }
      : {}),
    mergeRisk: {
      ...previewMergeRisk[0]!,
      verdict: "abstain",
      displayState,
      ...(displayState !== "disabled" ? { previous: prior } : {}),
    },
  });
}
previewPullRequests.push({
  ...fixtureBase,
  url: "https://github.com/example/dispatch/pull/1420",
  title: "Synthetic fixture · inconclusive",
  mergeRisk: { ...previewMergeRisk[0]!, verdict: "abstain" },
});
