import { describe, expect, it } from "vitest";
import { cpuPercentage } from "../src/agents/remote/health.js";
import { parseRunnerHealth } from "@dispatch/runner-protocol";

describe("runner health samples", () => {
  const reading = { scope: "quota-2", used: 10, total: 100 };
  it("reports CPU across comparable sample intervals", () => {
    expect(cpuPercentage(undefined, reading)).toBeNull();
    expect(cpuPercentage(reading, { ...reading, used: 30, total: 180 })).toBe(
      25
    );
    expect(cpuPercentage(reading, { ...reading, scope: "host" })).toBeNull();
  });
  it("bounds counters and stores only portable reported fields", () => {
    const sample = {
      version: "1.2.3",
      sessions: 2,
      working: 1,
      cpuPercent: null,
      memoryUsed: 5,
      memoryTotal: 10,
    };
    expect(parseRunnerHealth({ ...sample, arbitrary: true })).toEqual(sample);
    for (const update of [
      { sessions: -1 },
      { working: 3 },
      { cpuPercent: Infinity },
      { version: "bad\nversion" },
      { memoryUsed: 11 },
    ]) {
      expect(parseRunnerHealth({ ...sample, ...update })).toBeNull();
    }
  });
});
