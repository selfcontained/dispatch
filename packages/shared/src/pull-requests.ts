export type AgentPullRequest = {
  ci?: CiSnapshot;
  url: string;
  title: string;
  status: "Open" | "Draft" | "Merged" | "Closed" | "Unavailable" | "Pending";
  /** Display lifecycle plus a current recommendation or separately labeled history. */
  mergeRisk?: MergeRiskSummary;
};

export type CiSnapshot = {
  checkedAt: string;
  headSha: string;
  availability: "available" | "unavailable";
  summary: {
    status: "passing" | "failing" | "pending" | "none";
    total: number;
    passed: number;
    failed: number;
    pending: number;
    skipped: number;
  };
  checks: {
    /** Stable provider/workflow/context identity, independent of rerun attempt. */
    identity?: string;
    name: string;
    status: string;
    conclusion: string | null;
    detailsUrl: string | null;
    startedAt?: string;
    completedAt?: string;
  }[];
};

/**
 * A recommendation about whether a person should read a pull request before
 * it merges. Display only: it never merges, approves, or blocks anything.
 */
export type MergeRiskSummary = {
  /** Display lifecycle only; a non-current state is never a recommendation. */
  displayState?:
    | "disabled"
    | "unavailable"
    | "waiting_ci"
    | "waiting_review"
    | "not_ready"
    | "evaluating"
    | "deferred"
    | "daily_cap"
    | "capacity"
    | "rate_limited"
    | "failure";
  previous?: MergeRiskSummary;
  verdict: "routine" | "human_review" | "abstain";
  /** Probability-weighted level index: 0 low … 3 critical. */
  changeRisk: number | null;
  changeRiskLabel: string | null;
  reviewAdequate: number | null;
  descriptionMatches: number | null;
  /** Probability the change adds or redesigns a top-level product surface. */
  newSurface: number | null;
  routineProbability: number | null;
  humanReviewProbability: number | null;
  confidence: number | null;
  /** Provider status for the request that produced this record. */
  status: string;
  promptVersion: string;
  headSha: string;
  assessedAt: string;
};
