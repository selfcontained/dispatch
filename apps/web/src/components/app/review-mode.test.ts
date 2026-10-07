// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { draftsToReview, draftToFinding } from "./review-mode";

const draft = (
  id: string,
  comment: string,
  extra: { severity?: "blocker" | "major" | "minor" | "nit" } = {}
) => ({
  id,
  filePath: "src/a.ts",
  startLine: 4,
  endLine: 6,
  comment,
  ...extra,
});

describe("draftToFinding", () => {
  it("makes a finding of a comment: its first line the title, the whole the body", () => {
    expect(
      draftToFinding(draft("d1", "\n  Rename x  \nIt reads badly."))
    ).toEqual({
      severity: "minor",
      title: "Rename x",
      body: "\n  Rename x  \nIt reads badly.",
      path: "src/a.ts",
      line: 4,
    });
    // No id of its own: the server makes the finding a block.
    expect(draftToFinding(draft("d1", "x"))).not.toHaveProperty("id");
    expect(
      draftToFinding(draft("d2", "Guard it", { severity: "blocker" })).severity
    ).toBe("blocker");
    const long = draftToFinding(draft("d3", "y".repeat(200))).title;
    expect(long).toHaveLength(120);
    expect(long.endsWith("…")).toBe(true);
    expect(draftToFinding(draft("d4", "   ")).title).toBe("Comment");
  });
});

describe("draftsToReview", () => {
  it("is the summary and one finding per draft, with no verdict", () => {
    const review = draftsToReview("Two things.", [
      draft("d1", "Rename x"),
      draft("d2", "Guard it", { severity: "major" }),
    ]);
    expect(Object.keys(review).sort()).toEqual(["findings", "summary"]);
    expect(review.summary).toBe("Two things.");
    expect(review.findings.map((f) => [f.title, f.severity])).toEqual([
      ["Rename x", "minor"],
      ["Guard it", "major"],
    ]);
    expect(draftsToReview("Fine.", [])).toEqual({
      summary: "Fine.",
      findings: [],
    });
  });
});
