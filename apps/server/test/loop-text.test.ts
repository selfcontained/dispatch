import { describe, expect, it } from "vitest";

import { parseLoopItems } from "../src/shared/lib/loop-text.js";

describe("parseLoopItems", () => {
  it("strips bullet and numbered markers and trims each line", () => {
    expect(parseLoopItems("- First\n* Second\n+ Third")).toEqual([
      "First",
      "Second",
      "Third",
    ]);
    expect(parseLoopItems("1. First\n2) Second")).toEqual(["First", "Second"]);
    expect(parseLoopItems("  -   Padded  ")).toEqual(["Padded"]);
  });

  it("drops blank lines and returns an empty list for blank input", () => {
    expect(parseLoopItems("- First\n\n\n- Second")).toEqual([
      "First",
      "Second",
    ]);
    expect(parseLoopItems("")).toEqual([]);
    expect(parseLoopItems("   \n  ")).toEqual([]);
  });

  it("leaves text that only resembles a marker alone", () => {
    expect(parseLoopItems("-No space after dash")).toEqual([
      "-No space after dash",
    ]);
    expect(parseLoopItems("Ship v1.2 - then tag")).toEqual([
      "Ship v1.2 - then tag",
    ]);
  });
});
