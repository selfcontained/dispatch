import { describe, expect, it } from "vitest";

import { isVersionNewer } from "../version-compare";

describe("isVersionNewer", () => {
  it("returns true when version is newer (patch)", () => {
    expect(isVersionNewer("0.23.1", "0.23.0")).toBe(true);
  });

  it("returns true when version is newer (minor)", () => {
    expect(isVersionNewer("0.24.0", "0.23.5")).toBe(true);
  });

  it("returns true when version is newer (major)", () => {
    expect(isVersionNewer("1.0.0", "0.99.99")).toBe(true);
  });

  it("returns false when versions are equal", () => {
    expect(isVersionNewer("0.23.0", "0.23.0")).toBe(false);
  });

  it("returns false when version is older", () => {
    expect(isVersionNewer("0.22.0", "0.23.0")).toBe(false);
  });

  it("handles versions with v prefix", () => {
    expect(isVersionNewer("v0.24.0", "v0.23.0")).toBe(true);
  });

  it("returns false for equal versions with v prefix", () => {
    expect(isVersionNewer("v0.23.0", "0.23.0")).toBe(false);
  });
});
