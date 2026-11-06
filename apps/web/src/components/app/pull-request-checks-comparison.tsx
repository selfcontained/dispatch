import type { AgentPullRequest } from "@dispatch/shared";
import { PullRequestRow } from "./agent-pull-requests";
import { previewPullRequests } from "./agent-pull-requests.preview";

const passing = previewPullRequests[0];
const failing = previewPullRequests[1];
const waiting: AgentPullRequest = {
  ...failing,
  ci: failing.ci && {
    ...failing.ci,
    summary: {
      ...failing.ci.summary,
      status: "pending",
      failed: 0,
      total: failing.ci.summary.total - failing.ci.summary.failed,
    },
    checks: failing.ci.checks.filter((check) => check.conclusion !== "FAILURE"),
  },
};
const scenarios = [
  { title: "Failed + pending → red X", pr: failing },
  { title: "Passed + pending → yellow clock", pr: waiting },
  { title: "All passed → green check", pr: passing },
  {
    title: "No checks → blank",
    pr: {
      ...passing,
      ci: passing.ci && {
        ...passing.ci,
        summary: {
          status: "none" as const,
          total: 0,
          passed: 0,
          failed: 0,
          pending: 0,
          skipped: 0,
        },
        checks: [],
      },
    },
  },
  { title: "Unavailable → question mark", pr: { ...passing, ci: undefined } },
];

/** Design Lab fixtures rendered by the production row, including its popover. */
export function PullRequestChecksComparison() {
  return (
    <section className="mx-auto max-w-4xl space-y-6">
      <header>
        <h1 className="text-xl font-semibold">PR checks · single status</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Real sidebar components at their actual size, using sample checks.
          Failure takes priority, then pending, then passing. Each icon shows
          one status. Click an icon to see individual checks in the popover.
        </p>
      </header>
      <div className="grid gap-6 md:grid-cols-2">
        {scenarios.map(({ title, pr }) => (
          <article key={title} className="rounded-lg border border-border p-4">
            <h2 className="text-sm font-semibold">{title}</h2>
            <div className="mt-4 w-full max-w-72 rounded-lg border border-border bg-sidebar p-3">
              <p className="mb-3 text-xs font-medium">theme polish</p>
              <PullRequestRow pr={pr} isError={false} onDismiss={() => {}} />
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
