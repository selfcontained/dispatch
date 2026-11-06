import { describe, expect, it } from "vitest";
import { mapPullRequestChecks } from "../src/agents/pull-request-reader.js";
import {
  checkChanges,
  formatCheckNotice,
} from "../src/agents/pull-request-check-notice.js";
const pr = (results: string[], head = "abcdef123456789") => ({
  url: "https://github.com/a/b/pull/42",
  title: "Checks",
  status: "Open" as const,
  ci: mapPullRequestChecks(
    head,
    results.map((conclusion, i) => ({
      __typename: "CheckRun",
      name: "job" + i,
      status: conclusion ? "COMPLETED" : "IN_PROGRESS",
      conclusion,
      detailsUrl: "https://github.com/a/b/actions/runs/" + i,
      startedAt: "2026-11-06T00:00:00Z",
      completedAt: conclusion ? "2026-11-06T00:01:00Z" : null,
    }))
  ),
});
describe("check observations", () => {
  it("deduplicates identical snapshots regardless of observation timestamp or order", () => {
    const a = pr(["SUCCESS", "FAILURE"]);
    const b = pr(["SUCCESS", "FAILURE"]);
    b.ci.checkedAt = "later";
    b.ci.checks.reverse();
    expect(checkChanges(a, b)).toEqual([]);
  });
  it("coalesces terminal results while pending and non-actionable updates remain silent", () => {
    const a = pr(["", "", "", ""]);
    const b = pr(["SUCCESS", "FAILURE", "CANCELLED", ""]);
    expect(checkChanges(a, b).map((c) => c.name)).toEqual(["job0", "job1"]);
    const text = formatCheckNotice(a, b)!;
    expect(text).toContain("Outcome: failing");
    expect(text).toContain("1 pending");
    expect(text).toContain("60s");
    expect(text).toContain("actions/runs/1");
    expect(text).toContain("#42");
    expect(text).toContain("abcdef123456");
    expect(
      checkChanges(a, pr(["NEUTRAL", "SKIPPED", "CANCELLED", ""]))
    ).toEqual([]);
  });
  it("recognizes new heads, reruns and partial data without declaring success", () => {
    const a = pr(["SUCCESS"]);
    expect(checkChanges(a, pr(["SUCCESS"], "newhead"))).toHaveLength(1);
    expect(checkChanges(pr([""]), a)).toHaveLength(1);
    const rerun = pr(["SUCCESS"]);
    rerun.ci.checks[0].completedAt = "2026-11-06T01:00:00Z";
    expect(checkChanges(a, rerun)).toHaveLength(1);
    const unavailable = pr(["SUCCESS"]);
    unavailable.ci.availability = "unavailable";
    expect(checkChanges(a, unavailable)).toEqual([]);
    expect(formatCheckNotice(pr(["", ""]), pr(["SUCCESS", ""]))).toContain(
      "Outcome: pending"
    );
  });
  it("bounds results and removes duplicate aliases", () => {
    const a = pr(Array(20).fill(""));
    const b = pr(Array(20).fill("FAILURE"));
    b.ci.checks.push(b.ci.checks[0]);
    expect(checkChanges(a, b)).toHaveLength(20);
    const text = formatCheckNotice(a, b)!;
    expect(text).toContain("12 more");
    expect(text.match(/^- /gm)).toHaveLength(8);
  });
});
