import type { AgentPullRequest } from "@dispatch/shared";
import { mapPullRequestChecks } from "../src/agents/pull-request-reader.js";
export function riskFixture(): AgentPullRequest {
  return {
    url: "https://github.com/a/b/pull/123",
    title: "Risk fixture",
    status: "Open",
    ci: mapPullRequestChecks("abc123", [
      {
        __typename: "CheckRun",
        name: "test",
        status: "COMPLETED",
        conclusion: "SUCCESS",
      },
    ]),
    mergeRisk: {
      assessmentId: "decision-1",
      verdict: "routine",
      headSha: "abc123",
      status: "ok",
      assessedAt: "2026-11-10T00:00:00Z",
      promptVersion: "v1",
      changeRisk: 0,
      changeRiskLabel: "low",
      reviewAdequate: 1,
      descriptionMatches: 1,
      newSurface: 0,
      routineProbability: 0.9,
      humanReviewProbability: 0.1,
      confidence: 0.9,
    },
  };
}
