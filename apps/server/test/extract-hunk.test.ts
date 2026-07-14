import { describe, expect, it } from "vitest";
import { extractHunkAroundLines } from "../src/shared/lib/extract-hunk.js";

const SIMPLE_DIFF = [
  "diff --git a/file.ts b/file.ts",
  "--- a/file.ts",
  "+++ b/file.ts",
  "@@ -1,5 +1,6 @@",
  " line1",
  " line2",
  "+added line",
  " line3",
  " line4",
  " line5",
].join("\n");

const MULTI_HUNK_DIFF = [
  "diff --git a/file.ts b/file.ts",
  "--- a/file.ts",
  "+++ b/file.ts",
  "@@ -1,5 +1,6 @@",
  " line1",
  " line2",
  "+added early",
  " line3",
  " line4",
  " line5",
  "@@ -20,5 +21,6 @@",
  " line21",
  " line22",
  "+added late",
  " line23",
  " line24",
  " line25",
].join("\n");

describe("extractHunkAroundLines", () => {
  it("returns null for empty diff", () => {
    expect(extractHunkAroundLines("", 5, 5)).toBeNull();
  });

  it("returns null when no lines match the range", () => {
    expect(extractHunkAroundLines(SIMPLE_DIFF, 100, 100)).toBeNull();
  });

  it("extracts a single target line with context", () => {
    const result = extractHunkAroundLines(SIMPLE_DIFF, 3, 3);
    expect(result).not.toBeNull();
    expect(result).toContain("+added line");
    expect(result).toContain("@@ -1,5 +1,6 @@");
  });

  it("includes 3 lines of context before the target", () => {
    // Target line 5 => context starts at line 2
    const result = extractHunkAroundLines(SIMPLE_DIFF, 5, 5);
    expect(result).not.toBeNull();
    expect(result).toContain(" line2");
    expect(result).toContain("+added line");
  });

  it("includes 3 lines of context after the target", () => {
    // Target line 1 => context goes to new-file line 4 (line3 is at new-file line 4 due to insertion)
    const result = extractHunkAroundLines(SIMPLE_DIFF, 1, 1);
    expect(result).not.toBeNull();
    expect(result).toContain(" line1");
    expect(result).toContain(" line3");
  });

  it("extracts a range of lines", () => {
    const result = extractHunkAroundLines(SIMPLE_DIFF, 2, 4);
    expect(result).not.toBeNull();
    expect(result).toContain(" line2");
    expect(result).toContain("+added line");
    expect(result).toContain(" line4");
  });

  it("includes the hunk header in the output", () => {
    const result = extractHunkAroundLines(SIMPLE_DIFF, 3, 3);
    expect(result).not.toBeNull();
    const lines = result!.split("\n");
    expect(lines[0]).toBe("@@ -1,5 +1,6 @@");
  });

  it("selects the correct hunk from a multi-hunk diff", () => {
    const result = extractHunkAroundLines(MULTI_HUNK_DIFF, 23, 23);
    expect(result).not.toBeNull();
    expect(result).toContain("@@ -20,5 +21,6 @@");
    expect(result).toContain("+added late");
    expect(result).not.toContain("+added early");
  });

  it("selects the first hunk when target is in the first range", () => {
    const result = extractHunkAroundLines(MULTI_HUNK_DIFF, 3, 3);
    expect(result).not.toBeNull();
    expect(result).toContain("@@ -1,5 +1,6 @@");
    expect(result).toContain("+added early");
    expect(result).not.toContain("+added late");
  });

  it("includes deletion lines when already capturing", () => {
    const diffWithDeletion = [
      "diff --git a/file.ts b/file.ts",
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -1,8 +1,8 @@",
      " line1",
      " line2",
      " line3",
      "+new3b",
      "-old4",
      "+new4",
      " line5",
      " line6",
    ].join("\n");

    // Target line 4 (new3b). Capturing starts at line 4, so -old4 which comes
    // after is captured.
    const result = extractHunkAroundLines(diffWithDeletion, 4, 4);
    expect(result).not.toBeNull();
    expect(result).toContain("-old4");
    expect(result).toContain("+new4");
  });

  it("skips deletion lines before the range", () => {
    const diffWithEarlyDeletion = [
      "diff --git a/file.ts b/file.ts",
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -1,10 +1,9 @@",
      "-removed early",
      " line1",
      " line2",
      " line3",
      " line4",
      " line5",
      " line6",
      " line7",
      " line8",
      " line9",
    ].join("\n");

    // target line 8, context starts at line 5
    const result = extractHunkAroundLines(diffWithEarlyDeletion, 8, 8);
    expect(result).not.toBeNull();
    expect(result).not.toContain("-removed early");
  });

  it("handles diff headers before first hunk", () => {
    const result = extractHunkAroundLines(SIMPLE_DIFF, 1, 1);
    expect(result).not.toBeNull();
    expect(result).not.toContain("diff --git");
    expect(result).not.toContain("--- a/file.ts");
    expect(result).not.toContain("+++ b/file.ts");
  });

  it("handles hunk header with trailing function name", () => {
    const diff = [
      "diff --git a/file.ts b/file.ts",
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -10,5 +10,6 @@ function myFunc() {",
      " line10",
      " line11",
      "+added",
      " line12",
      " line13",
      " line14",
    ].join("\n");

    const result = extractHunkAroundLines(diff, 12, 12);
    expect(result).not.toBeNull();
    expect(result).toContain("@@ -10,5 +10,6 @@ function myFunc() {");
  });

  it("returns null when diff has no hunk headers", () => {
    const noHunk = [
      "diff --git a/file.ts b/file.ts",
      "--- a/file.ts",
      "+++ b/file.ts",
    ].join("\n");

    expect(extractHunkAroundLines(noHunk, 1, 1)).toBeNull();
  });

  it("handles startLine equal to endLine for single-line target", () => {
    const result = extractHunkAroundLines(SIMPLE_DIFF, 4, 4);
    expect(result).not.toBeNull();
    expect(result).toContain(" line4");
  });

  it("handles hunk starting at line 0", () => {
    const diff = [
      "diff --git a/file.ts b/file.ts",
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -0,0 +1,3 @@",
      "+line1",
      "+line2",
      "+line3",
    ].join("\n");

    const result = extractHunkAroundLines(diff, 1, 1);
    expect(result).not.toBeNull();
    expect(result).toContain("+line1");
    expect(result).toContain("+line2");
    expect(result).toContain("+line3");
  });

  it("stops capturing after endLine + 3 context", () => {
    const longDiff = [
      "diff --git a/file.ts b/file.ts",
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -1,20 +1,20 @@",
      ...Array.from({ length: 20 }, (_, i) => ` line${i + 1}`),
    ].join("\n");

    const result = extractHunkAroundLines(longDiff, 5, 5);
    expect(result).not.toBeNull();
    const lines = result!.split("\n").filter((l) => l !== "");
    // hunk header + context(3 before) + target(1) + context(3 after) = 1+7 = 8
    expect(lines.length).toBe(8);
  });

  it("captures deletion lines interleaved in the target range", () => {
    const diff = [
      "diff --git a/file.ts b/file.ts",
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -1,8 +1,8 @@",
      " line1",
      " line2",
      " line3",
      "-old4",
      "+new4",
      "-old5",
      "+new5",
      " line6",
      " line7",
      " line8",
    ].join("\n");

    const result = extractHunkAroundLines(diff, 4, 5);
    expect(result).not.toBeNull();
    expect(result).toContain("+new4");
    // -old5 is captured because capturing is true after +new4 (line 4)
    expect(result).toContain("-old5");
    expect(result).toContain("+new5");
  });

  it("handles adjacent hunks correctly", () => {
    const diff = [
      "diff --git a/file.ts b/file.ts",
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -1,3 +1,4 @@",
      " line1",
      " line2",
      "+insertA",
      " line3",
      "@@ -10,3 +11,4 @@",
      " line11",
      " line12",
      "+insertB",
      " line13",
    ].join("\n");

    const resultA = extractHunkAroundLines(diff, 3, 3);
    expect(resultA).not.toBeNull();
    expect(resultA).toContain("+insertA");
    expect(resultA).not.toContain("+insertB");

    const resultB = extractHunkAroundLines(diff, 12, 12);
    expect(resultB).not.toBeNull();
    expect(resultB).toContain("+insertB");
    expect(resultB).not.toContain("+insertA");
  });
});
