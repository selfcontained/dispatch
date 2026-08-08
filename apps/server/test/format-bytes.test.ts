import { describe, expect, it } from "vitest";

import { formatBytes } from "../src/shared/lib/format-bytes.js";

describe("formatBytes", () => {
  it("formats with spaced units by default", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(1536)).toBe("2 KB");
    expect(formatBytes(1024 * 1024 * 5.5)).toBe("5.5 MB");
    expect(formatBytes(1024 * 1024 * 1024 * 2.3)).toBe("2.3 GB");
  });

  it("formats with single-letter units when compact", () => {
    expect(formatBytes(900, { compact: true })).toBe("900B");
    expect(formatBytes(1536, { compact: true })).toBe("2K");
    expect(formatBytes(1024 * 1024 * 1.5, { compact: true })).toBe("1.5M");
    expect(formatBytes(1024 * 1024 * 1024 * 2.3, { compact: true })).toBe(
      "2.3G"
    );
  });
});
