import { describe, expect, it } from "vitest";

import { isPinType, validatePinValue } from "../src/pins.js";

describe("pin validation", () => {
  it("recognizes valid pin types", () => {
    expect(isPinType("string")).toBe(true);
    expect(isPinType("url")).toBe(true);
    expect(isPinType("port")).toBe(true);
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

  it("does not validate other pin types specially", () => {
    expect(() => validatePinValue("string", "line 1\nline 2")).not.toThrow();
    expect(() => validatePinValue("filename", "a.ts,\nb.ts")).not.toThrow();
  });
});
