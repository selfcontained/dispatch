import { describe, expect, it } from "vitest";

import { getNextRun, validateCronExpression } from "../../src/jobs/cron.js";

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

  describe("validateCronExpression", () => {
    it("returns true for valid expressions", () => {
      expect(validateCronExpression("0 * * * *")).toBe(true);
      expect(validateCronExpression("* * * * *")).toBe(true);
      expect(validateCronExpression("30 2 * * 1-5")).toBe(true);
      expect(validateCronExpression("0 0 1,15 * *")).toBe(true);
    });

    it("returns false for invalid expressions", () => {
      expect(validateCronExpression("not a cron")).toBe(false);
      expect(validateCronExpression("")).toBe(false);
      expect(validateCronExpression("60 * * * *")).toBe(false);
    });
  });
});
