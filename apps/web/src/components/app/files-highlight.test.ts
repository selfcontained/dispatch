// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { highlightFile } from "./files-highlight";

describe("Files syntax highlighting", () => {
  it("retains comment context across page boundaries and closes each line's markup", () => {
    const source = `/*\n${"inside the comment\n".repeat(205)}*/\nexport const value = 42;`;
    const result = highlightFile(source, "example.ts");
    expect(result.language).toBe("typescript");
    expect(result.lines).toHaveLength(source.split("\n").length);
    const line = document.createElement("div");
    line.innerHTML = result.lines![200]!;
    expect(line.querySelector(".hljs-comment")?.textContent).toBe(
      "inside the comment"
    );
    const last = document.createElement("div");
    last.innerHTML = result.lines!.at(-1)!;
    expect(last.querySelector(".hljs-comment")).toBeNull();
    expect(last.querySelector(".hljs-keyword")?.textContent).toBe("export");
  });

  it("escapes source markup instead of creating active elements", () => {
    const source =
      'const html = "<img src=x onerror=alert(1)><script>alert(2)</script>";';
    const result = highlightFile(source, "example.js");
    const element = document.createElement("div");
    element.innerHTML = result.lines!.join("\n");
    expect(element.textContent).toBe(source);
    expect(element.querySelector("img, script")).toBeNull();
    expect(element.querySelector(".hljs-string")).not.toBeNull();
  });

  it.each([
    ["untyped text", "notes.txt"],
    ["x".repeat(4001), "minified.js"],
    ["a\n".repeat(131073), "huge.ts"],
  ])("keeps unknown or over-budget input plain", (source, fileName) => {
    expect(highlightFile(source, fileName)).toEqual({
      language: null,
      lines: null,
    });
  });
});
