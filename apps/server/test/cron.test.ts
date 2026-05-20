import { describe, it, expect } from "vitest";

import {
  getNextRun,
  validateCronExpression,
  validateCronInterval,
} from "../src/jobs/cron.js";

describe("validateCronExpression", () => {
  it("accepts standard five-field expressions", () => {
    expect(validateCronExpression("0 * * * *")).toBe(true);
    expect(validateCronExpression("*/5 * * * *")).toBe(true);
    expect(validateCronExpression("0 9 * * 1-5")).toBe(true);
  });

  it("rejects empty or garbage strings", () => {
    expect(validateCronExpression("")).toBe(false);
    expect(validateCronExpression("not a cron")).toBe(false);
    expect(validateCronExpression("* * * *")).toBe(false);
  });
});

describe("validateCronInterval", () => {
  it("allows hourly schedule", () => {
    expect(validateCronInterval("0 * * * *")).toBeNull();
  });

  it("allows every-5-minutes schedule", () => {
    expect(validateCronInterval("*/5 * * * *")).toBeNull();
  });

  it("rejects every-minute schedule as too frequent", () => {
    const result = validateCronInterval("* * * * *");
    expect(result).toContain("too frequently");
    expect(result).toContain("60s");
  });

  it("rejects every-2-minutes as too frequent", () => {
    const result = validateCronInterval("*/2 * * * *");
    expect(result).toContain("too frequently");
    expect(result).toContain("120s");
  });

  it("rejects every-4-minutes as too frequent", () => {
    const result = validateCronInterval("*/4 * * * *");
    expect(result).toContain("too frequently");
    expect(result).toContain("240s");
  });

  it("returns error for invalid expression", () => {
    expect(validateCronInterval("garbage")).toBe("Invalid cron expression.");
  });
});

describe("getNextRun", () => {
  it("returns a Date for valid expression", () => {
    const next = getNextRun("0 * * * *");
    expect(next).toBeInstanceOf(Date);
    expect(next!.getTime()).toBeGreaterThan(Date.now());
  });

  it("returns null for invalid expression", () => {
    expect(getNextRun("not valid")).toBeNull();
  });
});
