// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { scheduleTime, sidebarScheduleTime } from "./scheduled-messages";

describe("sidebar schedule time", () => {
  const today = new Date(2026, 9, 15, 12);
  const time = (date: Date) =>
    date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  it("omits the date only on the same local calendar day", () => {
    const due = new Date(2026, 9, 15, 20, 45);
    expect(sidebarScheduleTime(due.toISOString(), today)).toBe(time(due));
    expect(scheduleTime(due.toISOString(), today)).toBe(
      `Oct 15 at ${time(due)}`
    );
  });

  it.each([14, 16])("keeps the date for a different local day (%s)", (day) => {
    const due = new Date(2026, 9, day, 20, 45);
    expect(sidebarScheduleTime(due.toISOString(), today)).toBe(
      `Oct ${day} at ${time(due)}`
    );
  });

  it("keeps the year across a year boundary", () => {
    const due = new Date(2027, 0, 1, 8, 45);
    expect(sidebarScheduleTime(due.toISOString(), new Date(2026, 11, 31))).toBe(
      `Jan 1, 2027 at ${time(due)}`
    );
  });

  it("compares local dates rather than the UTC day in the schedule string", () => {
    const due = new Date(2026, 9, 15, 23, 59);
    expect(sidebarScheduleTime(due.toISOString(), today)).toBe(time(due));
  });
});
