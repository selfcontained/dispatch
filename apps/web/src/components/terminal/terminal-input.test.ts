import { describe, expect, it } from "vitest";
import { applyCtrl } from "./terminal-input";

describe("applyCtrl", () => {
  it.each(Array.from("abcdefghijklmnopqrstuvwxyz@[\\]^_"))(
    "maps %s to its control byte",
    (char) => {
      expect(applyCtrl(char)).toBe(
        String.fromCharCode(char.toUpperCase().charCodeAt(0) & 31)
      );
    }
  );
  it.each(["1", "!", "\r", "\t", "\x1b[A", "paste", "é", "ß"])(
    "preserves %s",
    (data) => {
      expect(applyCtrl(data)).toBe(data);
    }
  );
});
