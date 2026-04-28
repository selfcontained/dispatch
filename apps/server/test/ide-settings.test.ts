import { describe, expect, it } from "vitest";

import { sanitizeEnabledIdes } from "../src/ide-settings.js";

describe("sanitizeEnabledIdes", () => {
  it("returns an empty array when the value is not an array", () => {
    expect(sanitizeEnabledIdes(undefined)).toEqual([]);
    expect(sanitizeEnabledIdes(null)).toEqual([]);
    expect(sanitizeEnabledIdes("vscode")).toEqual([]);
    expect(sanitizeEnabledIdes({ vscode: true })).toEqual([]);
  });

  it("filters unknown values and removes duplicates", () => {
    expect(
      sanitizeEnabledIdes(["vscode", "cursor", "vscode", "vscodium", 42, null])
    ).toEqual(["vscode", "cursor"]);
  });

  it("returns an empty array when no valid types remain", () => {
    expect(sanitizeEnabledIdes(["zed", "fleet"])).toEqual([]);
    expect(sanitizeEnabledIdes([])).toEqual([]);
  });

  it("preserves the input order of the first occurrence of each ide", () => {
    expect(sanitizeEnabledIdes(["cursor", "vscode"])).toEqual([
      "cursor",
      "vscode",
    ]);
  });
});
