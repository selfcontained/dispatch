import { describe, expect, it } from "vitest";

import {
  RECHECK_POLL_TIMEOUT,
  pollCadenceSeconds,
} from "../src/reviews/poll-cadence.js";
import {
  MAX_DIFF_BYTES,
  truncateDiffForPrompt,
} from "../src/personas/loader.js";

describe("pollCadenceSeconds", () => {
  const submittedAt = new Date("2026-04-22T00:00:00.000Z");

  it("returns 180 seconds before 9 minutes", () => {
    expect(
      pollCadenceSeconds(submittedAt, new Date("2026-04-22T00:08:59.000Z"))
    ).toBe(180);
  });

  it("returns 300 seconds at 9 minutes", () => {
    expect(
      pollCadenceSeconds(submittedAt, new Date("2026-04-22T00:09:00.000Z"))
    ).toBe(300);
  });

  it("returns 300 seconds before 24 minutes", () => {
    expect(
      pollCadenceSeconds(submittedAt, new Date("2026-04-22T00:23:59.000Z"))
    ).toBe(300);
  });

  it("returns 600 seconds at 24 minutes", () => {
    expect(
      pollCadenceSeconds(submittedAt, new Date("2026-04-22T00:24:00.000Z"))
    ).toBe(600);
  });

  it("returns 600 seconds at exactly two hours", () => {
    expect(
      pollCadenceSeconds(submittedAt, new Date("2026-04-22T02:00:00.000Z"))
    ).toBe(600);
  });

  it("returns the timeout marker after two hours", () => {
    expect(
      pollCadenceSeconds(submittedAt, new Date("2026-04-22T02:00:01.000Z"))
    ).toBe(RECHECK_POLL_TIMEOUT);
  });

  it("truncates oversized recheck diffs to the shared 50KB limit", () => {
    const largeDiff = "a".repeat(MAX_DIFF_BYTES + 1024);
    const truncated = truncateDiffForPrompt(largeDiff);

    expect(Buffer.byteLength(truncated, "utf-8")).toBeGreaterThan(
      MAX_DIFF_BYTES
    );
    expect(truncated).toContain("[... diff truncated at 50KB ...]");
  });
});
