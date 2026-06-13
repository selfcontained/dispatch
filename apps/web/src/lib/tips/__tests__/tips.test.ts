import { describe, expect, it } from "vitest";

import { tips } from "../tips";

describe("tips registry", () => {
  it("exports a non-empty array of tips", () => {
    expect(tips.length).toBeGreaterThan(0);
  });

  it("has unique IDs", () => {
    const ids = tips.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every tip has required fields", () => {
    for (const tip of tips) {
      expect(tip.id).toBeTruthy();
      expect(tip.title).toBeTruthy();
      expect(tip.body).toBeTruthy();
      expect(tip.since).toMatch(/^\d+\.\d+\.\d+$/);
      expect(tip.surfaces.length).toBeGreaterThan(0);
      for (const s of tip.surfaces) {
        expect(["inline", "ambient"]).toContain(s);
      }
    }
  });
});
