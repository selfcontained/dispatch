import { describe, it, expect } from "vitest";

import { parseBooleanSetting } from "../src/copy-mode-assist-settings.js";

describe("parseBooleanSetting", () => {
  it("returns true for 'true'", () => {
    expect(parseBooleanSetting("true", false)).toBe(true);
  });

  it("returns false for 'false'", () => {
    expect(parseBooleanSetting("false", true)).toBe(false);
  });

  it("returns the default for null", () => {
    expect(parseBooleanSetting(null, true)).toBe(true);
    expect(parseBooleanSetting(null, false)).toBe(false);
  });

  it("returns the default for unrecognized strings", () => {
    expect(parseBooleanSetting("yes", false)).toBe(false);
    expect(parseBooleanSetting("1", true)).toBe(true);
    expect(parseBooleanSetting("", false)).toBe(false);
  });
});
