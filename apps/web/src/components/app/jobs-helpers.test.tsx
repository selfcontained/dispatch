import { CheckCircle2, XCircle } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActivityBars } from "@/components/ui/activity-bars";
import { type JobRun, type JobRunStatus } from "@/hooks/use-jobs";
import { formatDateTime } from "@/lib/format";

import {
  cronError,
  formatJobDateTime,
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

describe("formatJobDateTime", () => {
  it("returns Not scheduled for null or undefined", () => {
    expect(formatJobDateTime(null)).toBe("Not scheduled");
    expect(formatJobDateTime(undefined)).toBe("Not scheduled");
    expect(formatJobDateTime("")).toBe("Not scheduled");
  });

  it("returns Unknown for an unparseable date", () => {
    expect(formatJobDateTime("not-a-date")).toBe("Unknown");
  });

  it("delegates valid dates to formatDateTime", () => {
    const iso = "2026-03-15T14:30:00Z";
    expect(formatJobDateTime(iso)).toBe(formatDateTime(iso));
    expect(formatJobDateTime(iso)).toMatch(/2026/);
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

describe("cronError", () => {
  it("requires a schedule only when the job is enabled", () => {
    expect(cronError("", true)).toBe(
      "Add a cron schedule or turn on the loop before enabling this job."
    );
    expect(cronError("   ", true)).toBe(
      "Add a cron schedule or turn on the loop before enabling this job."
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
