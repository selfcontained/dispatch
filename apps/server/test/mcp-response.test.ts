import { describe, expect, it } from "vitest";

import { jsonText, truncateLongStrings } from "../src/shared/mcp/response.js";

describe("jsonText", () => {
  it("serializes compactly, without indentation", () => {
    expect(jsonText({ a: 1, b: { c: [1, 2] } })).toBe(
      '{"a":1,"b":{"c":[1,2]}}'
    );
  });
});

describe("truncateLongStrings", () => {
  it("leaves strings at or under the cap untouched", () => {
    const value = { a: "x".repeat(10), b: "x".repeat(10) };
    expect(truncateLongStrings(value, 10)).toEqual(value);
  });

  it("marks how many characters were dropped", () => {
    expect(truncateLongStrings("x".repeat(25), 10)).toBe(
      `${"x".repeat(10)}…[+15 chars]`
    );
  });

  it("recurses through arrays and nested objects", () => {
    const result = truncateLongStrings(
      { items: [{ note: "y".repeat(12) }], keep: "short" },
      5
    );
    expect(result).toEqual({
      items: [{ note: `yyyyy…[+7 chars]` }],
      keep: "short",
    });
  });

  it("passes non-string leaves through unchanged", () => {
    const value = { n: 42, b: true, nil: null, missing: undefined };
    expect(truncateLongStrings(value, 2)).toEqual(value);
  });

  it("does not mutate its input", () => {
    const value = { note: "z".repeat(20) };
    truncateLongStrings(value, 5);
    expect(value.note).toHaveLength(20);
  });
});
