import { CheckCircle2, XCircle } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActivityBars } from "@/components/ui/activity-bars";
import { type JobRun, type JobRunStatus } from "@/hooks/use-jobs";
import { formatDateTime } from "@/lib/format";

import {
  cronError,
  errorMessage,
  formatDate,
  formatTimeUntil,
  formatTimeUntilDate,
  humanSchedule,
  minutesFromMs,
  msFromMinutes,
  statusClasses,
  statusDotColor,
  statusIcon,
  statusTextColor,
  triggerSourceLabel,
} from "./jobs-helpers";

const FAILURE_STATUSES: JobRunStatus[] = ["failed", "timed_out", "crashed"];

afterEach(() => {
  vi.useRealTimers();
});

describe("status mappers", () => {
  it("map completed to the done treatment", () => {
    expect(statusClasses("completed")).toContain("status-done");
    expect(statusTextColor("completed")).toBe("text-status-done");
    expect(statusDotColor("completed")).toBe("bg-status-done");
    expect(statusIcon("completed")?.type).toBe(CheckCircle2);
  });

  it("map every failure status to the blocked treatment", () => {
    for (const status of FAILURE_STATUSES) {
      expect(statusClasses(status)).toContain("status-blocked");
      expect(statusTextColor(status)).toBe("text-status-blocked");
      expect(statusDotColor(status)).toBe("bg-status-blocked");
      expect(statusIcon(status)?.type).toBe(XCircle);
    }
  });

  it("map needs_input to the waiting treatment with an activity icon", () => {
    expect(statusClasses("needs_input")).toContain("status-waiting");
    expect(statusTextColor("needs_input")).toBe("text-status-waiting");
    expect(statusDotColor("needs_input")).toBe("bg-status-waiting");
    expect(statusIcon("needs_input")?.type).toBe(ActivityBars);
  });

  it("map started and running to the working treatment with an activity icon", () => {
    for (const status of ["started", "running"] as const) {
      expect(statusClasses(status)).toContain("status-working");
      expect(statusTextColor(status)).toBe("text-status-working");
      expect(statusDotColor(status)).toBe("bg-status-working");
      expect(statusIcon(status)?.type).toBe(ActivityBars);
    }
  });

  it("fall back to muted styling and no icon for null", () => {
    expect(statusClasses(null)).toContain("text-muted-foreground");
    expect(statusTextColor(null)).toBe("text-muted-foreground");
    expect(statusDotColor(null)).toBe("bg-muted-foreground");
    expect(statusIcon(null)).toBeNull();
  });
});

describe("formatDate", () => {
  it("returns Not scheduled for null or undefined", () => {
    expect(formatDate(null)).toBe("Not scheduled");
    expect(formatDate(undefined)).toBe("Not scheduled");
    expect(formatDate("")).toBe("Not scheduled");
  });

  it("returns Unknown for an unparseable date", () => {
    expect(formatDate("not-a-date")).toBe("Unknown");
  });

  it("delegates valid dates to formatDateTime", () => {
    const iso = "2026-03-15T14:30:00Z";
    expect(formatDate(iso)).toBe(formatDateTime(iso));
    expect(formatDate(iso)).toMatch(/2026/);
  });
});

describe("minutesFromMs", () => {
  it("returns an empty string for null, undefined, and zero", () => {
    expect(minutesFromMs(null)).toBe("");
    expect(minutesFromMs(undefined)).toBe("");
    expect(minutesFromMs(0)).toBe("");
  });

  it("rounds to the nearest minute", () => {
    expect(minutesFromMs(60_000)).toBe("1");
    expect(minutesFromMs(90_000)).toBe("2");
    expect(minutesFromMs(150_000)).toBe("3");
  });

  it("clamps sub-minute values up to one minute", () => {
    expect(minutesFromMs(20_000)).toBe("1");
    expect(minutesFromMs(1)).toBe("1");
  });
});

describe("msFromMinutes", () => {
  it("converts whole minutes to milliseconds", () => {
    expect(msFromMinutes("30")).toBe(1_800_000);
    expect(msFromMinutes("1")).toBe(60_000);
  });

  it("returns undefined for zero, negative, and non-numeric input", () => {
    expect(msFromMinutes("0")).toBeUndefined();
    expect(msFromMinutes("-5")).toBeUndefined();
    expect(msFromMinutes("abc")).toBeUndefined();
    expect(msFromMinutes("")).toBeUndefined();
  });

  it("truncates fractional input like parseInt", () => {
    expect(msFromMinutes("2.7")).toBe(120_000);
  });

  it("round-trips with minutesFromMs", () => {
    expect(minutesFromMs(msFromMinutes("45"))).toBe("45");
  });
});

describe("errorMessage", () => {
  it("uses the message of Error instances", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("stringifies non-Error values", () => {
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(undefined)).toBe("undefined");
  });
});

describe("cronError", () => {
  it("requires a schedule only when the job is enabled", () => {
    expect(cronError("", true)).toBe(
      "Add a cron schedule before enabling this job."
    );
    expect(cronError("   ", true)).toBe(
      "Add a cron schedule before enabling this job."
    );
    expect(cronError("", false)).toBeNull();
    expect(cronError("   ", false)).toBeNull();
  });

  it("accepts a 5-field expression regardless of surrounding whitespace", () => {
    expect(cronError("*/30 * * * *", false)).toBeNull();
    expect(cronError("  0 3 * * 1-5  ", true)).toBeNull();
  });

  it("rejects expressions without exactly five fields", () => {
    const message = "Use a 5-field cron expression like */30 * * * *.";
    expect(cronError("* * * *", false)).toBe(message);
    expect(cronError("* * * * * *", true)).toBe(message);
  });
});

describe("humanSchedule", () => {
  it("returns On demand for null", () => {
    expect(humanSchedule(null)).toBe("On demand");
  });

  it("humanizes a valid cron expression", () => {
    expect(humanSchedule("*/30 * * * *")).toMatch(/every 30 minutes/i);
  });

  it("falls back to the trimmed raw expression when cronstrue throws", () => {
    expect(humanSchedule(" not a cron ")).toBe("Cron: not a cron");
  });
});

describe("triggerSourceLabel", () => {
  function makeRun(triggerSource?: "manual" | "scheduled" | "webhook"): JobRun {
    return { config: { triggerSource } } as JobRun;
  }

  it("labels each trigger source", () => {
    expect(triggerSourceLabel(makeRun("scheduled"))).toBe("Scheduled");
    expect(triggerSourceLabel(makeRun("webhook"))).toBe("Webhook");
    expect(triggerSourceLabel(makeRun("manual"))).toBe("Manual");
  });

  it("defaults missing trigger source to Manual", () => {
    expect(triggerSourceLabel(makeRun(undefined))).toBe("Manual");
  });
});

describe("formatTimeUntil", () => {
  const NOW = new Date(2026, 6, 24, 9, 0, 0);

  function at(offsetMs: number): string {
    return new Date(NOW.getTime() + offsetMs).toISOString();
  }

  it("returns now for past times and unparseable input", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(formatTimeUntil(at(-1))).toBe("now");
    expect(formatTimeUntil("not-a-date")).toBe("now");
  });

  it("returns < 1m under a minute", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(formatTimeUntil(at(30_000))).toBe("< 1m");
  });

  it("returns minutes under an hour", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(formatTimeUntil(at(5 * 60_000))).toBe("in 5m");
    expect(formatTimeUntil(at(59 * 60_000))).toBe("in 59m");
  });

  it("returns hours with a minute remainder under a day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(formatTimeUntil(at(90 * 60_000))).toBe("in 1h 30m");
    expect(formatTimeUntil(at(2 * 3_600_000))).toBe("in 2h");
    expect(formatTimeUntil(at(23 * 3_600_000 + 59 * 60_000))).toBe(
      "in 23h 59m"
    );
  });

  it("returns whole days from 24h up", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(formatTimeUntil(at(24 * 3_600_000))).toBe("in 1d");
    expect(formatTimeUntil(at(25 * 3_600_000))).toBe("in 1d");
    expect(formatTimeUntil(at(73 * 3_600_000))).toBe("in 3d");
  });
});

describe("formatTimeUntilDate", () => {
  const NOW = new Date(2026, 6, 24, 9, 0, 0);

  function timeOf(date: Date): string {
    return date.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }

  it("returns an empty string for unparseable input", () => {
    expect(formatTimeUntilDate("not-a-date")).toBe("");
  });

  it("labels a same-day time as Today", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const target = new Date(2026, 6, 24, 17, 30);
    expect(formatTimeUntilDate(target.toISOString())).toBe(
      `Today at ${timeOf(target)}`
    );
  });

  it("labels the next calendar day as Tomorrow", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const target = new Date(2026, 6, 25, 8, 0);
    expect(formatTimeUntilDate(target.toISOString())).toBe(
      `Tomorrow at ${timeOf(target)}`
    );
  });

  it("falls back to a weekday date for anything further out", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const target = new Date(2026, 6, 28, 10, 0);
    expect(formatTimeUntilDate(target.toISOString())).toBe(
      target.toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    );
  });
});
