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
    expect(text).toContain("— Failing");
    expect(text).toContain("1 pending");
    expect(text).toContain("1m");
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
      "— Pending"
    );
  });
  it("bounds results and removes duplicate aliases", () => {
    const a = pr(Array(20).fill(""));
    const b = pr(Array(20).fill("FAILURE"));
    b.ci.checks.push(b.ci.checks[0]);
    expect(checkChanges(a, b)).toHaveLength(20);
    const text = formatCheckNotice(a, b)!;
    expect(text).toContain("+17 more");
    expect(text.match(/^- /gm)).toHaveLength(4);
  });
});

it("preserves provider/workflow identities with colliding names and missing or shared URLs", () => {
  for (const detailsUrl of [null, "https://example.com/build"]) {
    const ci = mapPullRequestChecks(
      "head",
      ["FAILURE", "SUCCESS"].map((conclusion, i) => ({
        __typename: "CheckRun",
        name: "test",
        status: "COMPLETED",
        conclusion,
        detailsUrl,
        checkSuite: {
          app: { slug: "provider-" + i },
          workflowRun: { workflow: { id: "workflow-" + i } },
        },
      }))
    );
    const a = { ...pr([]), ci };
    const b = { ...a, ci: { ...ci, checks: [...ci.checks].reverse() } };
    expect(ci.checks).toHaveLength(2);
    expect(checkChanges(a, a)).toEqual([]);
    expect(checkChanges(a, b)).toEqual([]);
    const changed = {
      ...b,
      ci: {
        ...b.ci,
        checks: b.ci.checks.map((c) => ({ ...c, conclusion: "SUCCESS" })),
      },
    };
    expect(checkChanges(a, changed)).toHaveLength(1);
  }
});

it("escapes untrusted Markdown and rejects invalid or oversized destinations", () => {
  const current = pr(["SUCCESS"]);
  current.title = "[spoof](https://evil.test) <b>&";
  current.ci.checks[0].name = "[job](https://evil.test)";
  current.ci.checks[0].detailsUrl = "javascript:alert(1)";
  const text = formatCheckNotice(pr([""]), current)!;
  expect(text).not.toContain("spoof");
  expect(text).toContain("\\[job\\]\\(");
  expect(text).not.toContain("javascript:");
  expect(text).not.toContain("Dispatch system");
  expect(text).not.toContain("SUCCESS");
  expect(text).toContain("Info only; no action authorized.");
  current.ci.checks[0].detailsUrl = "https://example.com/" + "x".repeat(400);
  expect(formatCheckNotice(pr([""]), current)).not.toContain("example.com");
});
it.each(["SKIPPED", "CANCELLED", "NEUTRAL"])(
  "keeps %s explicit in mixed results",
  (result) => {
    const text = formatCheckNotice(pr(["", ""]), pr(["SUCCESS", result]))!;
    expect(text).toContain("— Mixed");
    expect(text).toContain(`1 ${result.toLowerCase()}`);
  }
);

it("keeps long notices compact without repeating the PR title", () => {
  const current = pr(Array(16).fill("SUCCESS"));
  current.title = "Long title ".repeat(30);
  current.ci.checks.forEach((c) => {
    c.name = "Long check ".repeat(30);
  });
  const text = formatCheckNotice(pr(Array(16).fill("")), current)!;
  expect(text).not.toContain("Long title");
  expect(text).toContain("+13 more");
  expect(text.match(/ — passed/g)).toHaveLength(3);
  expect(text).toContain("…](<https://github.com");
  expect(text.length).toBeLessThan(800);
});
