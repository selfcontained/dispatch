import { describe, expect, it } from "vitest";

import { lineageSeats, seatClasses } from "./agent-seat";

describe("lineageSeats", () => {
  const agents = [
    { id: "root", parentAgentId: null, createdAt: "2026-09-02T10:00:00Z" },
    { id: "kid2", parentAgentId: "root", createdAt: "2026-09-02T10:05:00Z" },
    { id: "kid1", parentAgentId: "root", createdAt: "2026-09-02T10:01:00Z" },
    { id: "grand", parentAgentId: "kid1", createdAt: "2026-09-02T10:03:00Z" },
    { id: "other", parentAgentId: null, createdAt: "2026-09-02T09:00:00Z" },
  ];

  it("numbers the root 1 and the rest of its tree in creation order, from any member", () => {
    const expected = { root: 1, kid1: 2, grand: 3, kid2: 4 };
    expect(lineageSeats("root", agents)).toEqual(expected);
    expect(lineageSeats("grand", agents)).toEqual(expected);
    // Another tree is another numbering.
    expect(lineageSeats("other", agents)).toEqual({ other: 1 });
    expect(lineageSeats("", agents)).toEqual({});
  });

  it("gives each seat its own accent and wraps past the palette", () => {
    expect(seatClasses(1)).not.toEqual(seatClasses(2));
    expect(seatClasses(11)).toEqual(seatClasses(1));
    expect(seatClasses(0)).toEqual(seatClasses(1));
  });
});
