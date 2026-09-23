import { describe, expect, it } from "vitest";

import { windowSegments } from "./windowed-rows";

const keys = ["a", "b", "c", "d", "e", "f"];
const height = (key: string) => (key === "c" ? 300 : 100);

describe("windowSegments", () => {
  it("renders the range and stands spacers in for the rows around it", () => {
    expect(
      windowSegments(keys, { from: 2, to: 4 }, () => false, height)
    ).toEqual([
      { kind: "gap", key: "gap:a", height: 200 },
      { kind: "rows", from: 2, to: 4 },
      { kind: "gap", key: "gap:e", height: 200 },
    ]);
  });

  it("renders a pinned row where it is, with the spacers split around it", () => {
    expect(
      windowSegments(keys, { from: 4, to: 6 }, (key) => key === "b", height)
    ).toEqual([
      { kind: "gap", key: "gap:a", height: 100 },
      { kind: "rows", from: 1, to: 2 },
      { kind: "gap", key: "gap:c", height: 400 },
      { kind: "rows", from: 4, to: 6 },
    ]);
  });

  it("joins a pinned row next to the range into one run", () => {
    expect(
      windowSegments(keys, { from: 1, to: 3 }, (key) => key === "d", height)
    ).toEqual([
      { kind: "gap", key: "gap:a", height: 100 },
      { kind: "rows", from: 1, to: 4 },
      { kind: "gap", key: "gap:e", height: 200 },
    ]);
  });

  it("is one run when everything is in range, and nothing for an empty list", () => {
    expect(
      windowSegments(keys, { from: 0, to: 6 }, () => false, height)
    ).toEqual([{ kind: "rows", from: 0, to: 6 }]);
    expect(windowSegments([], { from: 0, to: 0 }, () => false, height)).toEqual(
      []
    );
  });
});
