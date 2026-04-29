import { describe, expect, it } from "vitest";

import { timestampMediaFileName } from "../src/agents/media-seed.js";

describe("timestampMediaFileName", () => {
  // The function builds `<base>-<sanitized-iso>-<index+1><ext>`. ISO
  // timestamps contain colons and dots that are unsafe-or-noisy in
  // filenames, so the function strips them. Pinning the exact format
  // here makes a future drift (e.g. someone "modernizing" to
  // `Date.now()`) caught at the unit-test level rather than as a
  // surprising filename in production media listings.

  const FIXED_DATE = new Date("2026-04-29T08:15:30.250Z");

  it("emits `<base>-<yyyy-mm-dd-hh-mm-ss-ms>-<n><ext>`", () => {
    expect(timestampMediaFileName("photo.png", FIXED_DATE, 0)).toBe(
      "photo-2026-04-29-08-15-30-250-1.png"
    );
  });

  it("strips colons and dots from the ISO timestamp (filename safety)", () => {
    const out = timestampMediaFileName("x.txt", FIXED_DATE, 0);
    expect(out).not.toContain(":");
    // The only `.` in the output should be the one before the extension.
    expect(out.match(/\./g)).toHaveLength(1);
  });

  it("uses 1-based index suffix (the loop passes 0-based)", () => {
    expect(timestampMediaFileName("a.png", FIXED_DATE, 0)).toContain("-1.png");
    expect(timestampMediaFileName("a.png", FIXED_DATE, 1)).toContain("-2.png");
    expect(timestampMediaFileName("a.png", FIXED_DATE, 9)).toContain("-10.png");
  });

  it("preserves multi-character extensions", () => {
    expect(timestampMediaFileName("note.md", FIXED_DATE, 0)).toMatch(/\.md$/);
    expect(timestampMediaFileName("data.tar.gz", FIXED_DATE, 0)).toMatch(
      /\.gz$/
    );
  });

  it("handles files without an extension", () => {
    const out = timestampMediaFileName("README", FIXED_DATE, 0);
    expect(out).toBe("README-2026-04-29-08-15-30-250-1");
  });

  it("preserves dots inside the basename (e.g. `notes.v2.txt`)", () => {
    // path.basename + path.extname split on the LAST dot — so the base
    // is "notes.v2" and the extension is ".txt". The internal dot in
    // the basename stays.
    const out = timestampMediaFileName("notes.v2.txt", FIXED_DATE, 0);
    expect(out).toBe("notes.v2-2026-04-29-08-15-30-250-1.txt");
  });
});
