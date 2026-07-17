import { describe, expect, it } from "vitest";

import { buildDeviceName, buildSafariDeviceName } from "./device-name";

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

describe("buildSafariDeviceName", () => {
  const IPAD_UA =
    "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15";
  const IPAD_DESKTOP_UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
  const IPHONE_UA =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15";

  it("labels iPads including desktop-mode user agents", () => {
    expect(buildSafariDeviceName("ios", IPAD_UA, 5, "a1b2")).toBe(
      "Safari on iPadOS · A1B2"
    );
    expect(buildSafariDeviceName("ios", IPAD_DESKTOP_UA, 5, "a1b2")).toBe(
      "Safari on iPadOS · A1B2"
    );
  });

  it("labels iPhones as iOS", () => {
    expect(buildSafariDeviceName("ios", IPHONE_UA, 5, "c3d4")).toBe(
      "Safari on iOS · C3D4"
    );
  });

  it("labels Macs without relying on touch points", () => {
    expect(buildSafariDeviceName("mac", IPAD_DESKTOP_UA, 0, "e5f6")).toBe(
      "Safari on macOS · E5F6"
    );
  });

  it("keeps unknown platforms understandable", () => {
    expect(buildSafariDeviceName("unknown", "", 0, "beef")).toBe(
      "Safari on this device · BEEF"
    );
  });
});
