import { describe, expect, it } from "vitest";

import { formatSurfaceTime, humanizeLabel } from "./format";

describe("humanizeLabel", () => {
  it("sentence-cases separator-bearing machine tokens", () => {
    expect(humanizeLabel("IN_PROGRESS")).toBe("In progress");
    expect(humanizeLabel("ROLLED_BACK")).toBe("Rolled back");
    expect(humanizeLabel("waiting_for_ci")).toBe("Waiting for ci");
  });

  it("preserves plain all-caps values — acronyms, not enums", () => {
    for (const value of ["API", "AWS", "HTTP", "NASA", "CI"]) {
      expect(humanizeLabel(value)).toBe(value);
    }
  });

  it("passes real-world values through verbatim", () => {
    for (const value of [
      "v0.38.0-rc.2",
      "CI PASSING",
      "Rolled back",
      "api@4.18.0",
      "us-east-1",
    ]) {
      expect(humanizeLabel(value)).toBe(value);
    }
  });
});

describe("formatSurfaceTime", () => {
  const now = new Date("2026-09-02T12:00:00Z");

  it("renders relative under a week, never with seconds", () => {
    expect(formatSurfaceTime("2026-09-02T11:59:30Z", now).text).toBe(
      "just now"
    );
    expect(formatSurfaceTime("2026-09-02T11:15:00Z", now).text).toBe("45m ago");
    expect(formatSurfaceTime("2026-09-02T02:00:00Z", now).text).toBe("10h ago");
    expect(formatSurfaceTime("2026-08-30T12:00:00Z", now).text).toBe("3d ago");
  });

  it("renders compact absolutes beyond a week and for invalid input", () => {
    const older = formatSurfaceTime("2026-08-01T12:00:00Z", now);
    expect(older.text).not.toMatch(/ago/);
    expect(formatSurfaceTime("not-a-date", now).text).toBe("not-a-date");
  });
});
