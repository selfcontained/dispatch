import { describe, expect, it } from "vitest";

import { computeActivityStats, computeDailyStatus, type ActivityEventRow } from "../src/activity-metrics.js";

function row(agent_id: string, event_type: string, created_at: string): ActivityEventRow {
  return { agent_id, event_type, created_at: new Date(created_at) };
}

describe("activity metrics boundary carry-in", () => {
  it("counts time from the range start when a state began before the window", () => {
    const rows = [
      row("a1", "working", "2026-03-20T23:50:00Z"),
      row("a1", "done", "2026-03-21T00:20:00Z"),
    ];

    const stats = computeActivityStats(rows, new Date("2026-03-21T00:00:00Z"));

    expect(stats.totalWorkingMs).toBe(20 * 60 * 1000);
  });

  it("counts blocked and waiting averages from clipped boundary segments", () => {
    const rows = [
      row("a1", "blocked", "2026-03-20T23:55:00Z"),
      row("a1", "waiting_user", "2026-03-21T00:10:00Z"),
      row("a1", "done", "2026-03-21T00:25:00Z"),
    ];

    const stats = computeActivityStats(rows, new Date("2026-03-21T00:00:00Z"));

    expect(stats.avgBlockedMs).toBe(10 * 60 * 1000);
    expect(stats.avgWaitingMs).toBe(15 * 60 * 1000);
  });

  it("attributes carried-in status time to the in-range daily bucket", () => {
    const rows = [
      row("a1", "working", "2026-03-20T23:50:00Z"),
      row("a1", "done", "2026-03-21T00:20:00Z"),
    ];

    const days = computeDailyStatus(rows, new Date("2026-03-21T00:00:00Z"), "day");

    expect(days).toEqual([{ day: "2026-03-21", working: 20 * 60 * 1000 }]);
  });
});
