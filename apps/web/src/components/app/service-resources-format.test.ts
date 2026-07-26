import { describe, expect, it } from "vitest";

import type { ResourceHealthState } from "@/hooks/use-service-resources";

import {
  formatBytes,
  formatMs,
  formatUptime,
  metadataLabel,
  stateBadgeVariant,
  stateLabel,
} from "./service-resources-format";

describe("formatBytes", () => {
  it("returns an em dash for null", () => {
    expect(formatBytes(null)).toBe("—");
  });

  it("passes through values under 1024 as whole bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("converts at each unit boundary up the ladder", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 ** 2)).toBe("1.0 MB");
    expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
    expect(formatBytes(1024 ** 4)).toBe("1.0 TB");
  });

  it("stays in TB above the last unit instead of overflowing", () => {
    expect(formatBytes(1024 ** 5)).toBe("1024 TB");
  });

  it("shows one decimal below 10 and none at 10 or above", () => {
    expect(formatBytes(9.94 * 1024)).toBe("9.9 KB");
    expect(formatBytes(10 * 1024)).toBe("10 KB");
    expect(formatBytes(512.6 * 1024 ** 2)).toBe("513 MB");
  });
});

describe("formatMs", () => {
  it("returns an em dash for null", () => {
    expect(formatMs(null)).toBe("—");
  });

  it("collapses sub-millisecond values to <1 ms", () => {
    expect(formatMs(0)).toBe("<1 ms");
    expect(formatMs(0.9)).toBe("<1 ms");
  });

  it("rounds whole milliseconds below one second", () => {
    expect(formatMs(1)).toBe("1 ms");
    expect(formatMs(499.5)).toBe("500 ms");
    expect(formatMs(999.4)).toBe("999 ms");
  });

  it("switches to one-decimal seconds at 1000ms", () => {
    expect(formatMs(1000)).toBe("1.0 s");
    expect(formatMs(1500)).toBe("1.5 s");
    expect(formatMs(12_340)).toBe("12.3 s");
  });
});

describe("formatUptime", () => {
  it("shows minutes only under an hour", () => {
    expect(formatUptime(0)).toBe("0m");
    expect(formatUptime(59)).toBe("0m");
    expect(formatUptime(60)).toBe("1m");
    expect(formatUptime(3_599)).toBe("59m");
  });

  it("shows hours and minutes under a day", () => {
    expect(formatUptime(3_600)).toBe("1h 0m");
    expect(formatUptime(3_660)).toBe("1h 1m");
    expect(formatUptime(86_399)).toBe("23h 59m");
  });

  it("shows days and hours from one day up", () => {
    expect(formatUptime(86_400)).toBe("1d 0h");
    expect(formatUptime(90_000)).toBe("1d 1h");
    expect(formatUptime(2 * 86_400 + 3 * 3_600 + 59 * 60)).toBe("2d 3h");
  });
});

describe("stateLabel", () => {
  it("maps degraded to a friendly label", () => {
    expect(stateLabel("degraded")).toBe("Needs attention");
  });

  it("passes other states through", () => {
    expect(stateLabel("healthy")).toBe("healthy");
    expect(stateLabel("unavailable")).toBe("unavailable");
    expect(stateLabel("unknown")).toBe("unknown");
  });
});

describe("stateBadgeVariant", () => {
  it("maps every health state to its badge variant", () => {
    const cases: Array<[ResourceHealthState, string]> = [
      ["healthy", "running"],
      ["running", "running"],
      ["degraded", "error"],
      ["unavailable", "error"],
      ["unknown", "stopped"],
      ["idle", "default"],
      ["disabled", "default"],
    ];
    for (const [state, variant] of cases) {
      expect(stateBadgeVariant(state), state).toBe(variant);
    }
  });
});

describe("metadataLabel", () => {
  it("splits camelCase keys into lowercase words", () => {
    expect(metadataLabel("requestsPerMinute")).toBe("requests per minute");
    expect(metadataLabel("sseClients")).toBe("sse clients");
  });

  it("passes single lowercase words through", () => {
    expect(metadataLabel("failures")).toBe("failures");
  });

  it("lowercases without splitting on consecutive capitals", () => {
    expect(metadataLabel("dbIOPS")).toBe("db iops");
  });
});
