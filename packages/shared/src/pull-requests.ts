export type AgentPullRequest = {
  url: string;
  title: string;
  status: "Open" | "Draft" | "Merged" | "Closed" | "Unavailable" | "Pending";
};
