import { describe, expect, it } from "vitest";

import { isPinType, validatePinValue } from "../src/pins.js";

describe("pin validation", () => {
  it("recognizes valid pin types", () => {
    expect(isPinType("string")).toBe(true);
    expect(isPinType("url")).toBe(true);
    expect(isPinType("port")).toBe(true);
    expect(isPinType("markdown")).toBe(true);
    expect(isPinType("bogus")).toBe(false);
  });

  it("accepts valid http and https urls", () => {
    expect(() => validatePinValue("url", "http://localhost:3000")).not.toThrow();
    expect(() => validatePinValue("url", "https://example.com/path")).not.toThrow();
  });

  it("rejects invalid urls", () => {
    expect(() => validatePinValue("url", "localhost:3000")).toThrow(/valid http or https URLs/i);
    expect(() => validatePinValue("url", "ftp://example.com")).toThrow(/valid http or https URLs/i);
  });

  it("accepts integer ports in range", () => {
    expect(() => validatePinValue("port", "0")).not.toThrow();
    expect(() => validatePinValue("port", "3000")).not.toThrow();
    expect(() => validatePinValue("port", "65535")).not.toThrow();
    expect(() => validatePinValue("port", "3000 4000")).not.toThrow();
    expect(() => validatePinValue("port", "3000,\n4000")).not.toThrow();
  });

  it("rejects non-integer or out-of-range ports", () => {
    expect(() => validatePinValue("port", "3000.5")).toThrow(/integers/i);
    expect(() => validatePinValue("port", "abc")).toThrow(/integers/i);
    expect(() => validatePinValue("port", "localhost:3000")).toThrow(/integers/i);
    expect(() => validatePinValue("port", "-1")).toThrow(/integers/i);
    expect(() => validatePinValue("port", "65536")).toThrow(/0 and 65535/i);
  });

  it("accepts constrained markdown pins", () => {
    expect(() => validatePinValue("markdown", "**Status**\n- Ready\n- Branch: `feat/log-rotation`\n\n```sh\npnpm run check\n```")).not.toThrow();
  });

  it("rejects markdown pins with links", () => {
    expect(() => validatePinValue("markdown", "[Dispatch](https://github.com/selfcontained/dispatch)")).toThrow(/do not support links/i);
  });

  it("rejects markdown pins with images", () => {
    expect(() => validatePinValue("markdown", "![diagram](https://example.com/image.png)")).toThrow(/do not support images/i);
  });

  it("rejects markdown pins with raw html", () => {
    expect(() => validatePinValue("markdown", "<b>unsafe</b>")).toThrow(/do not support raw HTML/i);
  });

  it("rejects markdown pins with nested lists", () => {
    expect(() => validatePinValue("markdown", "- top\n  - nested")).toThrow(/do not support nested lists/i);
  });

  it("rejects markdown pins with oversized code blocks", () => {
    const longBlock = Array.from({ length: 21 }, (_, i) => `line ${i + 1}`).join("\n");
    expect(() => validatePinValue("markdown", `\`\`\`txt\n${longBlock}\n\`\`\``)).toThrow(/code blocks must be 20 lines or fewer/i);
  });

  it("does not validate other pin types specially", () => {
    expect(() => validatePinValue("string", "line 1\nline 2")).not.toThrow();
    expect(() => validatePinValue("filename", "a.ts,\nb.ts")).not.toThrow();
  });
});
