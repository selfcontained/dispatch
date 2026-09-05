import { describe, expect, it } from "vitest";

import { looksLikePathList, parseReadOutput, tryParseJson } from "./code-block";

describe("parseReadOutput", () => {
  it("strips dsh's wrapper and the line-number prefixes into a start line", () => {
    const out = parseReadOutput(
      "<path>/r/README.md</path>\n<type>file</type>\n<content>\n3: # Title\n4:\n5: body\n</content>"
    );
    expect(out).toEqual({
      path: "/r/README.md",
      type: "file",
      startLine: 3,
      code: "# Title\n\nbody",
    });
  });

  it("leaves unnumbered output alone", () => {
    expect(parseReadOutput("plain\ntext")).toEqual({ code: "plain\ntext" });
  });
});

describe("tryParseJson", () => {
  it("parses objects and arrays only", () => {
    expect(tryParseJson('{"a":1}')).toEqual({ a: 1 });
    expect(tryParseJson(" [1,2] ")).toEqual([1, 2]);
    expect(tryParseJson("42")).toBeNull();
    expect(tryParseJson("Updated agt: working")).toBeNull();
    expect(tryParseJson("{not json")).toBeNull();
  });
});

describe("looksLikePathList", () => {
  it("accepts newline-separated paths and rejects prose", () => {
    expect(looksLikePathList("a/b.ts\nnode_modules/x/README.md\n")).toBe(true);
    expect(looksLikePathList("Tree is clean")).toBe(false);
    expect(looksLikePathList("")).toBe(false);
  });
});
