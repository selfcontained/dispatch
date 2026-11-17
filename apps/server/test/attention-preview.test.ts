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

  it("treats a lone * as literal, keeping earlier markup and a word cut", () => {
    const text = `Run \`pnpm check\` for **2 * 3** cases ${"word ".repeat(120)}`;
    const preview = attentionPreview(text);
    expect(
      preview.startsWith("Run `pnpm check` for **2 * 3** cases word")
    ).toBe(true);
    expect(preview).toMatch(/word…$/);
  });

  it("skips an escaped * and cuts at the next space", () => {
    const text = `\\*not italic ${"word ".repeat(120)}`;
    const preview = attentionPreview(text);
    expect(preview.startsWith("\\*not italic word")).toBe(true);
    expect(preview).toMatch(/word…$/);
  });

  it("cuts before an italic span that straddles the limit", () => {
    const text = `${"a ".repeat(240)}*italic that runs past the limit ${"b ".repeat(20)}*`;
    const preview = attentionPreview(text);
    expect(preview).toBe(`${"a ".repeat(240).trimEnd()}…`);
  });

  it("keeps a leading bullet's markup and cuts at a space", () => {
    const text = `* item with **bold** ${"word ".repeat(120)}`;
    const preview = attentionPreview(text);
    expect(preview.startsWith("* item with **bold** word")).toBe(true);
    expect(preview).toMatch(/word…$/);
  });

  it("strips markup instead of collapsing when a span opens early", () => {
    const preview = attentionPreview(`Hi **${"word ".repeat(120)}**`);
    expect(preview.length).toBeGreaterThan(400);
    expect(preview).not.toMatch(/[*`[\]]/);
    expect(preview).toMatch(/word…$/);
  });

  it("strips an unmatched [ and keeps the text", () => {
    const preview = attentionPreview(`arr[0 ${"word ".repeat(120)}`);
    expect(preview.startsWith("arr0 word")).toBe(true);
    expect(preview.length).toBeGreaterThan(400);
  });

  it("drops a link URL cut by the fallback", () => {
    const preview = attentionPreview(
      `Hi **${"w ".repeat(240)}[label](https://x.test/${"p".repeat(40)})**`
    );
    expect(preview).not.toContain("https");
    expect(preview).not.toMatch(/[*`[\]()]/);
  });

  it("doesn't split a surrogate pair", () => {
    const preview = attentionPreview(`**${"x".repeat(496)}😀${"y".repeat(50)}`);
    expect(preview).toBe(`${"x".repeat(496)}…`);
  });

  it("strips markup when no safe boundary exists", () => {
    const preview = attentionPreview(`**${"x".repeat(600)}**`);
    expect(preview).toBe(`${"x".repeat(497)}…`);
  });
});
