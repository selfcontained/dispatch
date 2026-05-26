import { describe, expect, it } from "vitest";

import { isIdeType, sanitizeEnabledIdes, IDE_TYPES } from "./ide-types";

describe("isIdeType", () => {
  it.each(IDE_TYPES)("returns true for valid IDE type %s", (type) => {
    expect(isIdeType(type)).toBe(true);
  });

  it("returns false for unknown string", () => {
    expect(isIdeType("neovim")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isIdeType("")).toBe(false);
  });

  it("returns false for non-string types", () => {
    expect(isIdeType(42)).toBe(false);
    expect(isIdeType(null)).toBe(false);
    expect(isIdeType(undefined)).toBe(false);
    expect(isIdeType(true)).toBe(false);
    expect(isIdeType({})).toBe(false);
    expect(isIdeType([])).toBe(false);
  });
});

describe("sanitizeEnabledIdes", () => {
  it("returns valid IDE types from a mixed array", () => {
    expect(sanitizeEnabledIdes(["vscode", "bad", "cursor"])).toEqual([
      "vscode",
      "cursor",
    ]);
  });

  it("returns empty array for non-array input", () => {
    expect(sanitizeEnabledIdes("vscode")).toEqual([]);
    expect(sanitizeEnabledIdes(null)).toEqual([]);
    expect(sanitizeEnabledIdes(undefined)).toEqual([]);
    expect(sanitizeEnabledIdes(42)).toEqual([]);
    expect(sanitizeEnabledIdes({})).toEqual([]);
  });

  it("returns empty array for empty array", () => {
    expect(sanitizeEnabledIdes([])).toEqual([]);
  });

  it("returns empty array when no values are valid", () => {
    expect(sanitizeEnabledIdes(["neovim", "emacs", 42])).toEqual([]);
  });

  it("deduplicates repeated valid types", () => {
    expect(
      sanitizeEnabledIdes(["vscode", "cursor", "vscode", "cursor"])
    ).toEqual(["vscode", "cursor"]);
  });

  it("preserves order of first occurrence", () => {
    expect(sanitizeEnabledIdes(["cursor", "vscode"])).toEqual([
      "cursor",
      "vscode",
    ]);
  });

  it("filters out non-string array elements", () => {
    expect(sanitizeEnabledIdes([null, 0, false, "vscode", undefined])).toEqual([
      "vscode",
    ]);
  });
});
