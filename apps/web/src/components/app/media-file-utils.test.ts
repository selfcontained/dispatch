import { describe, expect, it } from "vitest";

import { stripTimestamp } from "./media-file-utils";

describe("stripTimestamp", () => {
  it("strips the upload timestamp suffix from a filename", () => {
    expect(stripTimestamp("screenshot-2026-07-29-12-34-56-123.png")).toBe(
      "screenshot.png"
    );
  });

  it("strips the timestamp when it sits mid-name", () => {
    expect(stripTimestamp("clip-2026-01-02-03-04-05-9-final.mp4")).toBe(
      "clip-final.mp4"
    );
  });

  it("leaves names without a timestamp untouched", () => {
    expect(stripTimestamp("notes.md")).toBe("notes.md");
    expect(stripTimestamp("report-v2.pdf")).toBe("report-v2.pdf");
  });

  it("leaves a date-only suffix untouched", () => {
    expect(stripTimestamp("export-2026-07-29.csv")).toBe(
      "export-2026-07-29.csv"
    );
  });

  it("requires the leading hyphen", () => {
    expect(stripTimestamp("2026-07-29-12-34-56-123.png")).toBe(
      "2026-07-29-12-34-56-123.png"
    );
  });
});
