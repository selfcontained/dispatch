import { describe, expect, it } from "vitest";

import { getNextRun, parseCronLines, removeTaggedLines, shellEscape } from "../../src/jobs/cron.js";

describe("cron utilities", () => {
  describe("getNextRun", () => {
    it("returns a Date for a valid cron expression", () => {
      const next = getNextRun("0 * * * *");
      expect(next).toBeInstanceOf(Date);
      expect(next!.getTime()).toBeGreaterThan(Date.now());
    });

    it("returns a Date for every-minute cron", () => {
      const next = getNextRun("* * * * *");
      expect(next).toBeInstanceOf(Date);
      expect(next!.getTime() - Date.now()).toBeLessThanOrEqual(60_000);
    });

    it("returns null for invalid cron expression", () => {
      expect(getNextRun("not a cron")).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(getNextRun("")).toBeNull();
    });

    it("handles complex cron expressions", () => {
      const next = getNextRun("30 2 * * 1-5");
      expect(next).toBeInstanceOf(Date);
    });

    it("handles day-of-month ranges", () => {
      const next = getNextRun("0 0 1,15 * *");
      expect(next).toBeInstanceOf(Date);
    });
  });

  describe("parseCronLines", () => {
    it("parses a single dispatch-managed entry", () => {
      const lines = [
        "# dispatch-job:/tmp/repo:janitor",
        "0 * * * * /usr/local/bin/dispatch jobs run janitor --dir /tmp/repo --no-wait",
        "",
      ];
      const entries = parseCronLines(lines);
      expect(entries).toEqual([
        { directory: "/tmp/repo", name: "janitor", schedule: "0 * * * *" },
      ]);
    });

    it("parses multiple dispatch-managed entries", () => {
      const lines = [
        "# dispatch-job:/tmp/repo:janitor",
        "0 * * * * /usr/local/bin/dispatch jobs run janitor --dir /tmp/repo --no-wait",
        "# dispatch-job:/home/user/project:cleanup",
        "30 2 * * 1-5 /usr/local/bin/dispatch jobs run cleanup --dir /home/user/project --no-wait",
        "",
      ];
      const entries = parseCronLines(lines);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual({ directory: "/tmp/repo", name: "janitor", schedule: "0 * * * *" });
      expect(entries[1]).toEqual({ directory: "/home/user/project", name: "cleanup", schedule: "30 2 * * 1-5" });
    });

    it("ignores non-dispatch cron entries", () => {
      const lines = [
        "# regular cron comment",
        "0 0 * * * /usr/bin/some-other-job",
        "# dispatch-job:/tmp/repo:janitor",
        "0 * * * * /usr/local/bin/dispatch jobs run janitor --dir /tmp/repo --no-wait",
        "",
      ];
      const entries = parseCronLines(lines);
      expect(entries).toHaveLength(1);
      expect(entries[0].name).toBe("janitor");
    });

    it("handles directory paths with colons", () => {
      // The parser uses lastIndexOf(":") to split, so directories with colons work
      const lines = [
        "# dispatch-job:/mnt/c:/Users/dev/repo:backup",
        "0 3 * * * /usr/local/bin/dispatch jobs run backup --dir /mnt/c:/Users/dev/repo --no-wait",
        "",
      ];
      const entries = parseCronLines(lines);
      expect(entries).toHaveLength(1);
      expect(entries[0].directory).toBe("/mnt/c:/Users/dev/repo");
      expect(entries[0].name).toBe("backup");
    });

    it("returns empty for empty crontab", () => {
      expect(parseCronLines([])).toEqual([]);
      expect(parseCronLines([""])).toEqual([]);
    });

    it("skips marker without following cron line", () => {
      const lines = [
        "# dispatch-job:/tmp/repo:janitor",
        "",
      ];
      const entries = parseCronLines(lines);
      expect(entries).toEqual([]);
    });

    it("skips marker followed by another comment", () => {
      const lines = [
        "# dispatch-job:/tmp/repo:janitor",
        "# another comment",
        "0 * * * * some command",
        "",
      ];
      const entries = parseCronLines(lines);
      expect(entries).toEqual([]);
    });
  });

  describe("removeTaggedLines", () => {
    it("removes tag and its following cron line", () => {
      const lines = [
        "# some other entry",
        "0 0 * * * other-job",
        "# dispatch-job:/tmp/repo:janitor",
        "0 * * * * dispatch jobs run janitor",
        "",
      ];
      const result = removeTaggedLines(lines, "# dispatch-job:/tmp/repo:janitor");
      expect(result).toEqual([
        "# some other entry",
        "0 0 * * * other-job",
        "",
      ]);
    });

    it("preserves lines when tag is not found", () => {
      const lines = ["# comment", "0 * * * * job", ""];
      const result = removeTaggedLines(lines, "# dispatch-job:/tmp/repo:missing");
      expect(result).toEqual(lines);
    });

    it("removes multiple instances of the same tag", () => {
      const lines = [
        "# dispatch-job:/tmp/repo:janitor",
        "0 * * * * first-entry",
        "# dispatch-job:/tmp/repo:janitor",
        "30 * * * * second-entry",
        "",
      ];
      const result = removeTaggedLines(lines, "# dispatch-job:/tmp/repo:janitor");
      expect(result).toEqual([""]);
    });

    it("handles tag at end of file without following line", () => {
      const lines = [
        "0 0 * * * other-job",
        "# dispatch-job:/tmp/repo:janitor",
      ];
      // When tag is the last line, i++ will go past bounds, skipping nothing extra
      const result = removeTaggedLines(lines, "# dispatch-job:/tmp/repo:janitor");
      expect(result).toEqual(["0 0 * * * other-job"]);
    });
  });

  describe("shellEscape", () => {
    it("returns safe values as-is", () => {
      expect(shellEscape("/usr/local/bin/dispatch")).toBe("/usr/local/bin/dispatch");
      expect(shellEscape("janitor")).toBe("janitor");
      expect(shellEscape("abc-123_def.txt")).toBe("abc-123_def.txt");
      expect(shellEscape("http://127.0.0.1:6767")).toBe("http://127.0.0.1:6767");
    });

    it("single-quotes values with spaces", () => {
      expect(shellEscape("/path/with spaces/dir")).toBe("'/path/with spaces/dir'");
    });

    it("escapes embedded single quotes", () => {
      expect(shellEscape("it's a test")).toBe("'it'\\''s a test'");
    });

    it("single-quotes values with special characters", () => {
      expect(shellEscape("hello$world")).toBe("'hello$world'");
      expect(shellEscape("cmd; rm -rf")).toBe("'cmd; rm -rf'");
      expect(shellEscape("$(evil)")).toBe("'$(evil)'");
    });
  });
});
