import { describe, expect, it } from "vitest";

import { buildActiveHours, type ActiveHourEvent } from "./active-hours";

describe("buildActiveHours", () => {
  const now = new Date("2026-01-15T12:00:00Z");

  it("returns 168 cells (7 days x 24 hours) for empty input", () => {
    const cells = buildActiveHours([], now);
    expect(cells).toHaveLength(168);
    expect(cells.every((c) => c.count === 0 && c.avgPerWeek === 0)).toBe(true);
  });

  it("counts events in the correct day/hour bucket", () => {
    const d = new Date(2026, 0, 14, 10, 0, 0);
    const expectedDay = d.getDay();
    const expectedHour = d.getHours();

    const events: ActiveHourEvent[] = [
      { created_at: d.toISOString() },
      { created_at: d.toISOString() },
    ];

    const cells = buildActiveHours(events, now);
    const cell = cells.find(
      (c) => c.dayOfWeek === expectedDay && c.hour === expectedHour
    );
    expect(cell?.count).toBe(2);
  });

  it("skips events with invalid timestamps", () => {
    const events: ActiveHourEvent[] = [
      { created_at: "not-a-date" },
      { created_at: new Date("2026-01-14T10:00:00Z").toISOString() },
    ];

    const cells = buildActiveHours(events, now);
    const totalCount = cells.reduce((sum, c) => sum + c.count, 0);
    expect(totalCount).toBe(1);
  });

  it("computes avgPerWeek based on the event span", () => {
    const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    const events: ActiveHourEvent[] = [
      { created_at: twoWeeksAgo.toISOString() },
      { created_at: now.toISOString() },
    ];

    const cells = buildActiveHours(events, now);
    const nonZero = cells.filter((c) => c.count > 0);
    for (const cell of nonZero) {
      expect(cell.avgPerWeek).toBeLessThanOrEqual(cell.count);
    }
  });

  it("clamps span to at least 1 week", () => {
    const events: ActiveHourEvent[] = [{ created_at: now.toISOString() }];

    const cells = buildActiveHours(events, now);
    const cell = cells.find((c) => c.count === 1);
    expect(cell?.avgPerWeek).toBe(1);
  });
});
