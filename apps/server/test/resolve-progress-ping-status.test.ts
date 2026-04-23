import { describe, it, expect } from "vitest";

import { resolveProgressPingStatus } from "../src/agents/manager.js";

describe("resolveProgressPingStatus", () => {
  it("accepts 'reviewing'", () => {
    expect(resolveProgressPingStatus("reviewing")).toBe("reviewing");
  });

  it("rejects any other status with a 400-level AgentError and the valid set", () => {
    expect(() => resolveProgressPingStatus("complete")).toThrow(
      /Invalid review status "complete"/
    );
    expect(() => resolveProgressPingStatus("complete")).toThrow(
      /Must be one of: reviewing/
    );
    expect(() => resolveProgressPingStatus("cancelled")).toThrow(
      /Invalid review status "cancelled"/
    );
    expect(() => resolveProgressPingStatus("")).toThrow(
      /Invalid review status/
    );
  });

  it("rejection error carries a 400 status code", () => {
    try {
      resolveProgressPingStatus("bogus");
      throw new Error("expected throw");
    } catch (err) {
      const asAny = err as { statusCode?: number };
      expect(asAny.statusCode).toBe(400);
    }
  });
});
