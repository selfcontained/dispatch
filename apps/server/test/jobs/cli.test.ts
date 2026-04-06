import { describe, expect, it, vi } from "vitest";

import { parseArgs, formatTimeAgo, formatTimeUntil, formatDuration } from "../../src/jobs/cli.js";

describe("CLI parseArgs", () => {
  // parseArgs calls process.exit on error — mock it to throw instead
  const mockExit = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });
  const mockConsoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleError.mockClear();
  });

  describe("run subcommand", () => {
    it("parses basic run command", () => {
      const args = parseArgs(["jobs", "run", "janitor"]);
      expect(args).toEqual({ command: "run", name: "janitor", dir: process.cwd(), noWait: false });
    });

    it("parses run with --dir", () => {
      const args = parseArgs(["jobs", "run", "janitor", "--dir", "/tmp/repo"]);
      expect(args).toEqual({ command: "run", name: "janitor", dir: "/tmp/repo", noWait: false });
    });

    it("parses run with --no-wait", () => {
      const args = parseArgs(["jobs", "run", "janitor", "--no-wait"]);
      expect(args).toEqual({ command: "run", name: "janitor", dir: process.cwd(), noWait: true });
    });

    it("parses run with all flags", () => {
      const args = parseArgs(["jobs", "run", "janitor", "--dir", "/tmp/repo", "--no-wait"]);
      expect(args).toEqual({ command: "run", name: "janitor", dir: "/tmp/repo", noWait: true });
    });
  });

  describe("enable subcommand", () => {
    it("parses basic enable", () => {
      const args = parseArgs(["jobs", "enable", "janitor"]);
      expect(args).toEqual({ command: "enable", name: "janitor", dir: process.cwd() });
    });

    it("parses enable with --dir", () => {
      const args = parseArgs(["jobs", "enable", "janitor", "--dir", "/tmp/repo"]);
      expect(args).toEqual({ command: "enable", name: "janitor", dir: "/tmp/repo" });
    });
  });

  describe("disable subcommand", () => {
    it("parses basic disable", () => {
      const args = parseArgs(["jobs", "disable", "cleanup"]);
      expect(args).toEqual({ command: "disable", name: "cleanup", dir: process.cwd() });
    });

    it("parses disable with --dir", () => {
      const args = parseArgs(["jobs", "disable", "cleanup", "--dir", "/opt/project"]);
      expect(args).toEqual({ command: "disable", name: "cleanup", dir: "/opt/project" });
    });
  });

  describe("list subcommand", () => {
    it("parses list", () => {
      const args = parseArgs(["jobs", "list"]);
      expect(args).toEqual({ command: "list" });
    });
  });

  describe("history subcommand", () => {
    it("parses basic history", () => {
      const args = parseArgs(["jobs", "history", "janitor"]);
      expect(args).toEqual({ command: "history", name: "janitor", dir: process.cwd(), limit: 20 });
    });

    it("parses history with --dir and --limit", () => {
      const args = parseArgs(["jobs", "history", "janitor", "--dir", "/tmp/repo", "--limit", "5"]);
      expect(args).toEqual({ command: "history", name: "janitor", dir: "/tmp/repo", limit: 5 });
    });
  });

  describe("error cases", () => {
    it("exits on missing jobs prefix", () => {
      expect(() => parseArgs(["notjobs", "run", "foo"])).toThrow("process.exit(1)");
    });

    it("exits on unknown subcommand", () => {
      expect(() => parseArgs(["jobs", "unknown"])).toThrow("process.exit(1)");
    });

    it("exits on missing name for run", () => {
      expect(() => parseArgs(["jobs", "run"])).toThrow("process.exit(1)");
    });

    it("exits on name starting with dash for run", () => {
      expect(() => parseArgs(["jobs", "run", "--name"])).toThrow("process.exit(1)");
    });

    it("exits on missing name for enable", () => {
      expect(() => parseArgs(["jobs", "enable"])).toThrow("process.exit(1)");
    });

    it("exits on missing name for history", () => {
      expect(() => parseArgs(["jobs", "history"])).toThrow("process.exit(1)");
    });
  });
});

describe("formatTimeAgo", () => {
  it("returns 'just now' for recent timestamps", () => {
    expect(formatTimeAgo(new Date().toISOString())).toBe("just now");
  });

  it("returns minutes for timestamps under an hour", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(formatTimeAgo(fiveMinAgo)).toBe("5m ago");
  });

  it("returns hours for timestamps under a day", () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 3_600_000).toISOString();
    expect(formatTimeAgo(threeHoursAgo)).toBe("3h ago");
  });

  it("returns days for older timestamps", () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
    expect(formatTimeAgo(twoDaysAgo)).toBe("2d ago");
  });

  it("returns 'unknown' for non-string input", () => {
    expect(formatTimeAgo(null)).toBe("unknown");
    expect(formatTimeAgo(undefined)).toBe("unknown");
    expect(formatTimeAgo(123)).toBe("unknown");
  });

  it("returns 'just now' for future timestamps", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(formatTimeAgo(future)).toBe("just now");
  });
});

describe("formatTimeUntil", () => {
  it("returns 'now' for past timestamps", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(formatTimeUntil(past)).toBe("now");
  });

  it("returns minutes for near-future timestamps", () => {
    const inFiveMin = new Date(Date.now() + 5 * 60_000 + 30_000).toISOString();
    expect(formatTimeUntil(inFiveMin)).toBe("in 5m");
  });

  it("returns hours and minutes for multi-hour timestamps", () => {
    const inTwoHours = new Date(Date.now() + 2 * 3_600_000 + 15 * 60_000).toISOString();
    expect(formatTimeUntil(inTwoHours)).toBe("in 2h 15m");
  });

  it("returns days for distant timestamps", () => {
    // Add a small buffer so we're solidly in "3 days" territory
    const inThreeDays = new Date(Date.now() + 3 * 86_400_000 + 3_600_000).toISOString();
    expect(formatTimeUntil(inThreeDays)).toBe("in 3d");
  });

  it("returns 'unknown' for non-string input", () => {
    expect(formatTimeUntil(null)).toBe("unknown");
  });
});

describe("formatDuration", () => {
  it("formats milliseconds", () => {
    expect(formatDuration(500)).toBe("500ms");
  });

  it("formats seconds", () => {
    expect(formatDuration(5_000)).toBe("5s");
    expect(formatDuration(59_000)).toBe("59s");
  });

  it("formats minutes", () => {
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(90_000)).toBe("1m 30s");
  });

  it("formats hours", () => {
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(5_400_000)).toBe("1h 30m");
  });
});
