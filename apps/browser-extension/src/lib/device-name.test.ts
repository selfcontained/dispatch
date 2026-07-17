import { describe, expect, it } from "vitest";

import { buildDeviceName } from "./device-name";

describe("buildDeviceName", () => {
  it("creates a recognizable profile-specific browser label", () => {
    expect(buildDeviceName("mac", "a1b2")).toBe("Chrome on macOS · A1B2");
    expect(buildDeviceName("win", "4c9d")).toBe("Chrome on Windows · 4C9D");
  });

  it("keeps unknown platforms understandable", () => {
    expect(buildDeviceName("unknown", "beef")).toBe(
      "Chrome on this device · BEEF"
    );
  });
});
