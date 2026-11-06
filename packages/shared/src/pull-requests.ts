export type AgentPullRequest = {
  ci?: CiSnapshot;
  url: string;
  title: string;
  status: "Open" | "Draft" | "Merged" | "Closed" | "Unavailable" | "Pending";
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
    name: string;
    status: string;
    conclusion: string | null;
    detailsUrl: string | null;
  }[];
};
