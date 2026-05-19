import { describe, expect, it } from "vitest";

import { splitPinValues } from "./pins";

describe("splitPinValues", () => {
  describe("filename type", () => {
    it("splits comma-separated filenames", () => {
      expect(splitPinValues("filename", "a.ts,b.ts")).toEqual(["a.ts", "b.ts"]);
    });

    it("splits newline-separated filenames", () => {
      expect(splitPinValues("filename", "a.ts\nb.ts")).toEqual([
        "a.ts",
        "b.ts",
      ]);
    });

    it("trims whitespace from parts", () => {
      expect(splitPinValues("filename", " a.ts , b.ts ")).toEqual([
        "a.ts",
        "b.ts",
      ]);
    });

    it("returns original value when splitting yields nothing", () => {
      expect(splitPinValues("filename", "")).toEqual([""]);
    });
  });

  describe("port type", () => {
    it("splits space-separated ports", () => {
      expect(splitPinValues("port", "3000 3001")).toEqual(["3000", "3001"]);
    });

    it("splits comma-separated ports", () => {
      expect(splitPinValues("port", "3000,3001")).toEqual(["3000", "3001"]);
    });

    it("handles mixed delimiters", () => {
      expect(splitPinValues("port", "3000, 3001 3002")).toEqual([
        "3000",
        "3001",
        "3002",
      ]);
    });
  });

  describe("other types", () => {
    it("returns value as single-element array for string type", () => {
      expect(splitPinValues("string", "hello world")).toEqual(["hello world"]);
    });

    it("returns value as single-element array for url type", () => {
      expect(splitPinValues("url", "http://example.com")).toEqual([
        "http://example.com",
      ]);
    });
  });
});
