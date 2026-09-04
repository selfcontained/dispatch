import { describe, expect, it } from "vitest";

import { diffLines } from "@/components/app/chat/stream-entries";

describe("diffLines", () => {
  it("aligns an insertion without marking every following line", () => {
    const out = diffLines("a\nb\nc", "x\na\nb\nc");
    expect(out).toEqual([
      { kind: "add", text: "x" },
      { kind: "same", text: "a" },
      { kind: "same", text: "b" },
      { kind: "same", text: "c" },
    ]);
  });

  it("treats a null old text as an empty file", () => {
    expect(diffLines(null, "one\ntwo")).toEqual([
      { kind: "add", text: "one" },
      { kind: "add", text: "two" },
    ]);
  });

  it("marks a replaced line as one removal and one addition", () => {
    expect(diffLines("a\nb", "a\nc")).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "c" },
    ]);
  });
});
