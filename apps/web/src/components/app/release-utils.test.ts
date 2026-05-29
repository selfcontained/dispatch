import { describe, expect, it } from "vitest";

import {
  cleanError,
  describeForceTriggers,
  formatBytes,
  formatInlineProgress,
  formatProgressLabel,
  progressPercent,
} from "./release-utils";

describe("cleanError", () => {
  it("extracts stderr from a compound error message", () => {
    expect(cleanError("command failed stderr=some error")).toBe("some error");
  });

  it("strips leading 'fatal:' from stderr", () => {
    expect(cleanError("exit 128 stderr=fatal: not a git repo")).toBe(
      "not a git repo"
    );
  });

  it("returns the raw string when no stderr= marker is present", () => {
    expect(cleanError("plain error message")).toBe("plain error message");
  });

  it("trims whitespace around the extracted stderr", () => {
    expect(cleanError("stderr=  spaced  ")).toBe("spaced");
  });
});

describe("formatBytes", () => {
  it("formats bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("formats kilobytes", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("2 KB");
    expect(formatBytes(1024 * 512)).toBe("512 KB");
  });

  it("formats megabytes", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1024 * 1024 * 5.5)).toBe("5.5 MB");
  });

  it("formats gigabytes", () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
    expect(formatBytes(1024 * 1024 * 1024 * 2.3)).toBe("2.3 GB");
  });
});

describe("formatProgressLabel", () => {
  it("returns null when no progress exists", () => {
    expect(formatProgressLabel({ progress: null } as never)).toBeNull();
  });

  it("formats percentage with byte counts when total is known", () => {
    const result = formatProgressLabel({
      progress: { bytesReceived: 512 * 1024, totalBytes: 1024 * 1024 },
    } as never);
    expect(result).toBe("50% · 512 KB / 1.0 MB");
  });

  it("clamps percentage to 100", () => {
    const result = formatProgressLabel({
      progress: { bytesReceived: 2000, totalBytes: 1000 },
    } as never);
    expect(result).toMatch(/^100%/);
  });

  it("shows downloaded bytes when total is unknown", () => {
    const result = formatProgressLabel({
      progress: {
        bytesReceived: 1024 * 1024 * 3,
        totalBytes: null,
      },
    } as never);
    expect(result).toBe("3.0 MB downloaded");
  });

  it("returns null when bytesReceived is zero and total is unknown", () => {
    const result = formatProgressLabel({
      progress: { bytesReceived: 0, totalBytes: null },
    } as never);
    expect(result).toBeNull();
  });

  it("falls back to downloaded format when totalBytes is zero", () => {
    const result = formatProgressLabel({
      progress: { bytesReceived: 100, totalBytes: 0 },
    } as never);
    expect(result).toBe("100 B downloaded");
  });
});

describe("formatInlineProgress", () => {
  it("returns null when progress is null", () => {
    expect(formatInlineProgress(null)).toBeNull();
  });

  it("includes label and percentage when total is known", () => {
    const result = formatInlineProgress({
      label: "Downloading",
      bytesReceived: 500,
      totalBytes: 1000,
    } as never);
    expect(result).toBe("Downloading · 50% · 500 B / 1000 B");
  });

  it("includes label and downloaded when total is unknown", () => {
    const result = formatInlineProgress({
      label: "Downloading",
      bytesReceived: 2048,
      totalBytes: null,
    } as never);
    expect(result).toBe("Downloading · 2 KB downloaded");
  });

  it("returns just the label when no byte info is available", () => {
    const result = formatInlineProgress({
      label: "Preparing",
      bytesReceived: null,
      totalBytes: null,
    } as never);
    expect(result).toBe("Preparing");
  });
});

describe("progressPercent", () => {
  it("returns null when progress is null", () => {
    expect(progressPercent(null)).toBeNull();
  });

  it("returns null when bytesReceived is null", () => {
    expect(
      progressPercent({ bytesReceived: null, totalBytes: 1000 } as never)
    ).toBeNull();
  });

  it("returns null when totalBytes is null", () => {
    expect(
      progressPercent({ bytesReceived: 500, totalBytes: null } as never)
    ).toBeNull();
  });

  it("returns null when totalBytes is zero", () => {
    expect(
      progressPercent({ bytesReceived: 500, totalBytes: 0 } as never)
    ).toBeNull();
  });

  it("returns null when totalBytes is negative", () => {
    expect(
      progressPercent({ bytesReceived: 500, totalBytes: -1 } as never)
    ).toBeNull();
  });

  it("calculates percent correctly", () => {
    expect(
      progressPercent({ bytesReceived: 250, totalBytes: 1000 } as never)
    ).toBe(25);
  });

  it("clamps to 100", () => {
    expect(
      progressPercent({ bytesReceived: 2000, totalBytes: 1000 } as never)
    ).toBe(100);
  });
});

describe("describeForceTriggers", () => {
  it("describes pending migrations (singular)", () => {
    expect(describeForceTriggers({ pendingMigrations: ["m1"] } as never)).toBe(
      "has 1 complex update step; safer with the agent"
    );
  });

  it("describes pending migrations (plural)", () => {
    expect(
      describeForceTriggers({ pendingMigrations: ["m1", "m2", "m3"] } as never)
    ).toBe("has 3 complex update steps; safer with the agent");
  });

  it("describes required assisted mode", () => {
    expect(
      describeForceTriggers({
        pendingMigrations: [],
        assisted: { mode: "required" },
      } as never)
    ).toBe("needs the agent for a safe update");
  });

  it("describes migrations error", () => {
    expect(
      describeForceTriggers({
        pendingMigrations: [],
        assisted: null,
        migrationsError: "timeout",
      } as never)
    ).toBe("couldn't be checked for complex update steps");
  });

  it("returns generic fallback when no specific trigger matches", () => {
    expect(
      describeForceTriggers({
        pendingMigrations: [],
        assisted: { mode: "recommended" },
        migrationsError: null,
      } as never)
    ).toBe("is gated by the assisted-update flow");
  });
});
