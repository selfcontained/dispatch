import { describe, expect, it } from "vitest";
import { emojiQueryAt, emojiShortcodes, matchEmoji } from "./emoji-shortcodes";

describe("emoji shortcodes", () => {
  it("offers labeled prefix matches and common aliases", () => {
    expect(matchEmoji("smi").map(([alias]) => alias)).toContain("smile");
    for (const alias of ["smile", "heart", "thumbsup", "+1", "thumbs-up"])
      expect(emojiShortcodes[alias]).toBeTruthy();
    expect(matchEmoji("not_an_emoji")).toEqual([]);
  });
  it("uses UTF-16 offsets at the caret across lines", () => {
    const text = "😀 @reviewer\n:smi tail";
    expect(emojiQueryAt(text, text.indexOf(" tail"))).toEqual({
      start: 13,
      query: "smi",
    });
  });
  it.each([
    "https://host:smi",
    "12:30",
    "word:smi",
    "`:smi",
    "```js\n:smi",
    "~~~\n:smi",
  ])("leaves literal or unrelated colon text alone: %s", (text) => {
    expect(emojiQueryAt(text, text.length)).toBeNull();
  });
  it("allows text after closed code spans", () => {
    const text = "`code` :heart";
    expect(emojiQueryAt(text, text.length)?.query).toBe("heart");
  });
});
