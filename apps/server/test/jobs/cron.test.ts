import { describe, expect, it } from "vitest";

import { getNextRun } from "../../src/jobs/cron.js";

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
      // Should be within the next 60 seconds
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
  });
});
