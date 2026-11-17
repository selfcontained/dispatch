import { attentionPreview } from "@dispatch/shared";
import { describe, expect, it } from "vitest";

describe("attentionPreview", () => {
  it("keeps the first non-empty line whole when it fits", () => {
    expect(attentionPreview("\n\n  **Ship** it?  \nmore")).toBe("**Ship** it?");
    expect(attentionPreview("   \n ")).toBe("");
  });

  it("keeps a line longer than the old 80-character cut", () => {
    const line = `**${"word ".repeat(30).trim()}** done`;
    expect(attentionPreview(line)).toBe(line);
  });

  it("cuts long lines outside any open span", () => {
    const cases = [
      `${"a ".repeat(240)}**bold that runs past the limit ${"b ".repeat(20)}**`,
      `${"a ".repeat(240)}\`code that runs past the limit ${"b ".repeat(20)}\``,
      `${"a ".repeat(240)}[a link label ${"b ".repeat(20)}](https://x.test/y)`,
      `${"a ".repeat(245)}see [link](https://x.test/${"p".repeat(40)}) ok`,
    ];
    for (const text of cases) {
      const preview = attentionPreview(text, 500);
      expect(preview.length).toBeLessThanOrEqual(500);
      expect(preview.endsWith("…")).toBe(true);
      const body = preview.slice(0, -1);
      expect(body.split("**").length % 2).toBe(1);
      expect(body.split("`").length % 2).toBe(1);
      expect(body.split("[").length).toBe(body.split("]").length);
    }
  });

  it("strips markup when no safe boundary exists", () => {
    const preview = attentionPreview(`**${"x".repeat(600)}**`);
    expect(preview).toBe(`${"x".repeat(497)}…`);
  });
});
