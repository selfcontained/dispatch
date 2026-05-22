import { describe, expect, it } from "vitest";

import {
  computeActivityStats,
  computeDailyStatus,
  computeWorkingTimeByProject,
  type ActivityEventRow,
} from "../src/activity-metrics.js";

function row(
  agent_id: string,
  event_type: string,
  created_at: string,
  project_dir?: string
): ActivityEventRow {
  return {
    agent_id,
    event_type,
    created_at: new Date(created_at),
    project_dir: project_dir ?? null,
  };
}

const MIN = 60 * 1000;

describe("computeActivityStats", () => {
  it("returns zeroes for empty input", () => {
    const stats = computeActivityStats([], null);
    expect(stats.totalWorkingMs).toBe(0);
    expect(stats.avgBlockedMs).toBe(0);
    expect(stats.avgWaitingMs).toBe(0);
    expect(stats.stateDurations).toEqual({
      working: 0,
      blocked: 0,
      waiting_user: 0,
    });
  });

  it("returns zeroes for a single event (no transitions)", () => {
    const stats = computeActivityStats(
      [row("a1", "working", "2026-01-01T00:00:00Z")],
      null
    );
    expect(stats.totalWorkingMs).toBe(0);
  });

  it("accumulates working time across transitions", () => {
    const rows = [
      row("a1", "working", "2026-01-01T00:00:00Z"),
      row("a1", "blocked", "2026-01-01T00:10:00Z"),
      row("a1", "working", "2026-01-01T00:15:00Z"),
      row("a1", "done", "2026-01-01T00:25:00Z"),
    ];
    const stats = computeActivityStats(rows, null);
    expect(stats.totalWorkingMs).toBe(20 * MIN);
    expect(stats.stateDurations.blocked).toBe(5 * MIN);
  });

  it("does not count done or idle segments", () => {
    const rows = [
      row("a1", "working", "2026-01-01T00:00:00Z"),
      row("a1", "done", "2026-01-01T00:10:00Z"),
      row("a1", "working", "2026-01-01T01:00:00Z"),
      row("a1", "done", "2026-01-01T01:05:00Z"),
    ];
    const stats = computeActivityStats(rows, null);
    expect(stats.totalWorkingMs).toBe(15 * MIN);
  });

  it("tracks multiple agents independently", () => {
    const rows = [
      row("a1", "working", "2026-01-01T00:00:00Z"),
      row("a1", "done", "2026-01-01T00:10:00Z"),
      row("a2", "working", "2026-01-01T00:00:00Z"),
      row("a2", "done", "2026-01-01T00:20:00Z"),
    ];
    const stats = computeActivityStats(rows, null);
    expect(stats.totalWorkingMs).toBe(30 * MIN);
  });

  it("averages blocked and waiting across sessions", () => {
    const rows = [
      row("a1", "blocked", "2026-01-01T00:00:00Z"),
      row("a1", "done", "2026-01-01T00:10:00Z"),
      row("a1", "blocked", "2026-01-01T01:00:00Z"),
      row("a1", "done", "2026-01-01T01:20:00Z"),
    ];
    const stats = computeActivityStats(rows, null);
    expect(stats.avgBlockedMs).toBe(15 * MIN);
  });

  it("clips segments to rangeStart when a state spans the boundary", () => {
    const rows = [
      row("a1", "working", "2026-03-20T23:50:00Z"),
      row("a1", "done", "2026-03-21T00:20:00Z"),
    ];
    const stats = computeActivityStats(rows, new Date("2026-03-21T00:00:00Z"));
    expect(stats.totalWorkingMs).toBe(20 * MIN);
  });

  it("clips blocked and waiting segments at rangeStart", () => {
    const rows = [
      row("a1", "blocked", "2026-03-20T23:55:00Z"),
      row("a1", "waiting_user", "2026-03-21T00:10:00Z"),
      row("a1", "done", "2026-03-21T00:25:00Z"),
    ];
    const stats = computeActivityStats(rows, new Date("2026-03-21T00:00:00Z"));
    expect(stats.avgBlockedMs).toBe(10 * MIN);
    expect(stats.avgWaitingMs).toBe(15 * MIN);
  });

  it("resets session accumulators after done events", () => {
    const rows = [
      row("a1", "blocked", "2026-01-01T00:00:00Z"),
      row("a1", "done", "2026-01-01T00:05:00Z"),
      row("a1", "waiting_user", "2026-01-01T01:00:00Z"),
      row("a1", "done", "2026-01-01T01:10:00Z"),
    ];
    const stats = computeActivityStats(rows, null);
    expect(stats.avgBlockedMs).toBe(Math.round((5 * MIN) / 2));
    expect(stats.avgWaitingMs).toBe(Math.round((10 * MIN) / 2));
  });

  it("handles waiting_user state correctly", () => {
    const rows = [
      row("a1", "waiting_user", "2026-01-01T00:00:00Z"),
      row("a1", "working", "2026-01-01T00:30:00Z"),
      row("a1", "done", "2026-01-01T00:45:00Z"),
    ];
    const stats = computeActivityStats(rows, null);
    expect(stats.stateDurations.waiting_user).toBe(30 * MIN);
    expect(stats.totalWorkingMs).toBe(15 * MIN);
  });
});

describe("computeDailyStatus", () => {
  it("returns empty array for empty input", () => {
    expect(computeDailyStatus([], null, "day")).toEqual([]);
  });

  it("returns empty array for a single event (no transitions)", () => {
    const rows = [row("a1", "working", "2026-01-01T12:00:00Z")];
    expect(computeDailyStatus(rows, null, "day")).toEqual([]);
  });

  it("groups working time by day", () => {
    const rows = [
      row("a1", "working", "2026-01-01T12:00:00Z"),
      row("a1", "done", "2026-01-01T12:30:00Z"),
    ];
    const days = computeDailyStatus(rows, null, "day");
    expect(days).toHaveLength(1);
    expect(days[0].working).toBe(30 * MIN);
  });

  it("groups by hour granularity", () => {
    const rows = [
      row("a1", "working", "2026-01-01T12:00:00Z"),
      row("a1", "blocked", "2026-01-01T12:20:00Z"),
      row("a1", "done", "2026-01-01T12:30:00Z"),
    ];
    const hours = computeDailyStatus(rows, null, "hour");
    expect(hours).toHaveLength(1);
    expect(hours[0].working).toBe(20 * MIN);
    expect(hours[0].blocked).toBe(10 * MIN);
    expect(String(hours[0].day)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:00$/);
  });

  it("separates events across day boundaries", () => {
    const rows = [
      row("a1", "working", "2026-01-01T12:00:00Z"),
      row("a1", "done", "2026-01-01T12:10:00Z"),
      row("a1", "working", "2026-01-02T12:00:00Z"),
      row("a1", "done", "2026-01-02T12:20:00Z"),
    ];
    const days = computeDailyStatus(rows, null, "day");
    expect(days).toHaveLength(2);
    const totalWorking =
      (days[0].working as number) + (days[1].working as number);
    expect(totalWorking).toBe(30 * MIN);
  });

  it("does not count done/idle segments", () => {
    const rows = [
      row("a1", "working", "2026-01-01T12:00:00Z"),
      row("a1", "done", "2026-01-01T12:10:00Z"),
      row("a1", "working", "2026-01-01T13:00:00Z"),
      row("a1", "done", "2026-01-01T13:05:00Z"),
    ];
    const days = computeDailyStatus(rows, null, "day");
    expect(days).toHaveLength(1);
    expect(days[0].working).toBe(15 * MIN);
  });

  it("clips segments at rangeStart", () => {
    const rows = [
      row("a1", "working", "2026-03-20T12:00:00Z"),
      row("a1", "done", "2026-03-21T12:20:00Z"),
    ];
    const rangeStart = new Date("2026-03-21T12:00:00Z");
    const days = computeDailyStatus(rows, rangeStart, "day");
    const expectedDay = new Date(rangeStart).toLocaleDateString("en-CA");
    expect(days).toEqual([{ day: expectedDay, working: 20 * MIN }]);
  });

  it("tracks multiple event types in the same bucket", () => {
    const rows = [
      row("a1", "working", "2026-01-01T12:00:00Z"),
      row("a1", "blocked", "2026-01-01T12:10:00Z"),
      row("a1", "waiting_user", "2026-01-01T12:15:00Z"),
      row("a1", "done", "2026-01-01T12:25:00Z"),
    ];
    const days = computeDailyStatus(rows, null, "day");
    expect(days).toHaveLength(1);
    expect(days[0].working).toBe(10 * MIN);
    expect(days[0].blocked).toBe(5 * MIN);
    expect(days[0].waiting_user).toBe(10 * MIN);
  });

  it("returns results sorted by day ascending", () => {
    const rows = [
      row("a1", "working", "2026-01-03T12:00:00Z"),
      row("a1", "done", "2026-01-03T12:10:00Z"),
      row("a2", "working", "2026-01-01T12:00:00Z"),
      row("a2", "done", "2026-01-01T12:10:00Z"),
    ];
    const days = computeDailyStatus(rows, null, "day");
    expect(days).toHaveLength(2);
    expect(String(days[0].day) < String(days[1].day)).toBe(true);
  });
});

describe("computeWorkingTimeByProject", () => {
  it("returns empty array for empty input", () => {
    expect(computeWorkingTimeByProject([], null)).toEqual([]);
  });

  it("returns empty array for a single event", () => {
    expect(
      computeWorkingTimeByProject(
        [row("a1", "working", "2026-01-01T00:00:00Z", "/proj")],
        null
      )
    ).toEqual([]);
  });

  it("accumulates working time for a project", () => {
    const rows = [
      row("a1", "working", "2026-01-01T00:00:00Z", "/proj-a"),
      row("a1", "done", "2026-01-01T00:30:00Z", "/proj-a"),
    ];
    const result = computeWorkingTimeByProject(rows, null);
    expect(result).toEqual([
      { project_dir: "/proj-a", working_time_ms: 30 * MIN },
    ]);
  });

  it("separates time by project directory", () => {
    const rows = [
      row("a1", "working", "2026-01-01T00:00:00Z", "/proj-a"),
      row("a1", "done", "2026-01-01T00:10:00Z", "/proj-a"),
      row("a2", "working", "2026-01-01T00:00:00Z", "/proj-b"),
      row("a2", "done", "2026-01-01T00:20:00Z", "/proj-b"),
    ];
    const result = computeWorkingTimeByProject(rows, null);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      project_dir: "/proj-b",
      working_time_ms: 20 * MIN,
    });
    expect(result[1]).toEqual({
      project_dir: "/proj-a",
      working_time_ms: 10 * MIN,
    });
  });

  it("only counts working segments, not blocked or waiting", () => {
    const rows = [
      row("a1", "working", "2026-01-01T00:00:00Z", "/proj"),
      row("a1", "blocked", "2026-01-01T00:10:00Z", "/proj"),
      row("a1", "working", "2026-01-01T00:15:00Z", "/proj"),
      row("a1", "done", "2026-01-01T00:25:00Z", "/proj"),
    ];
    const result = computeWorkingTimeByProject(rows, null);
    expect(result).toEqual([
      { project_dir: "/proj", working_time_ms: 20 * MIN },
    ]);
  });

  it("ignores events without a project directory", () => {
    const rows = [
      row("a1", "working", "2026-01-01T00:00:00Z"),
      row("a1", "done", "2026-01-01T00:10:00Z"),
    ];
    const result = computeWorkingTimeByProject(rows, null);
    expect(result).toEqual([]);
  });

  it("sorts results by working time descending", () => {
    const rows = [
      row("a1", "working", "2026-01-01T00:00:00Z", "/small"),
      row("a1", "done", "2026-01-01T00:05:00Z", "/small"),
      row("a2", "working", "2026-01-01T00:00:00Z", "/big"),
      row("a2", "done", "2026-01-01T01:00:00Z", "/big"),
    ];
    const result = computeWorkingTimeByProject(rows, null);
    expect(result[0].project_dir).toBe("/big");
    expect(result[1].project_dir).toBe("/small");
  });

  it("clips segments at rangeStart", () => {
    const rows = [
      row("a1", "working", "2026-01-01T23:50:00Z", "/proj"),
      row("a1", "done", "2026-01-02T00:10:00Z", "/proj"),
    ];
    const result = computeWorkingTimeByProject(
      rows,
      new Date("2026-01-02T00:00:00Z")
    );
    expect(result).toEqual([
      { project_dir: "/proj", working_time_ms: 10 * MIN },
    ]);
  });

  it("limits output to 20 projects", () => {
    const rows: ActivityEventRow[] = [];
    for (let i = 0; i < 25; i++) {
      const proj = `/proj-${String(i).padStart(2, "0")}`;
      const agentId = `a${i}`;
      rows.push(row(agentId, "working", "2026-01-01T00:00:00Z", proj));
      rows.push(row(agentId, "done", "2026-01-01T00:10:00Z", proj));
    }
    const result = computeWorkingTimeByProject(rows, null);
    expect(result).toHaveLength(20);
  });
});
