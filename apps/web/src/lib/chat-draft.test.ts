import { describe, expect, it } from "vitest";

import {
  CHAT_DRAFT_MAX_BYTES,
  CHAT_DRAFT_TRUNCATED_MARKER,
  type ChatComposerDraft,
  chatDraftBytes,
  EMPTY_CHAT_DRAFT,
  fitChatDraft,
  isChatComposerDraft,
  isEmptyChatDraft,
} from "./chat-draft";

describe("chat draft", () => {
  it("recognises the stored shape and rejects anything else", () => {
    expect(isChatComposerDraft(EMPTY_CHAT_DRAFT)).toBe(true);
    expect(
      isChatComposerDraft({
        text: "hi",
        links: ["https://a"],
        pinIds: ["p1"],
        files: [
          { name: "a.png", size: 3, mime: "image/png" },
          { name: "pasted.txt", size: 9, mime: "text/plain", pasted: "x" },
          { name: "pasted-2.txt", size: 9, mime: "text/plain", pasted: null },
        ],
      })
    ).toBe(true);
    expect(isChatComposerDraft(null)).toBe(false);
    expect(isChatComposerDraft("hi")).toBe(false);
    expect(
      isChatComposerDraft({ text: 1, links: [], pinIds: [], files: [] })
    ).toBe(false);
    expect(
      isChatComposerDraft({ text: "", links: [1], pinIds: [], files: [] })
    ).toBe(false);
    expect(
      isChatComposerDraft({
        text: "",
        links: [],
        pinIds: [],
        files: [{ name: "a" }],
      })
    ).toBe(false);
  });

  it("knows an empty draft", () => {
    expect(isEmptyChatDraft(EMPTY_CHAT_DRAFT)).toBe(true);
    expect(isEmptyChatDraft({ ...EMPTY_CHAT_DRAFT, text: " " })).toBe(false);
    expect(
      isEmptyChatDraft({
        ...EMPTY_CHAT_DRAFT,
        files: [{ name: "a", size: 1, mime: "" }],
      })
    ).toBe(false);
  });

  it("leaves a draft under the cap untouched", () => {
    const draft: ChatComposerDraft = {
      text: "hello",
      links: [],
      pinIds: [],
      files: [
        { name: "pasted.txt", size: 5, mime: "text/plain", pasted: "12345" },
      ],
    };
    expect(fitChatDraft(draft)).toBe(draft);
  });

  it("drops pasted bodies largest-first until the draft fits", () => {
    const big = "x".repeat(CHAT_DRAFT_MAX_BYTES);
    const medium = "y".repeat(1000);
    const draft: ChatComposerDraft = {
      text: "keep me",
      links: ["https://example.com"],
      pinIds: ["pin"],
      files: [
        { name: "a.png", size: 1, mime: "image/png" },
        {
          name: "pasted.txt",
          size: medium.length,
          mime: "text/plain",
          pasted: medium,
        },
        {
          name: "pasted-2.txt",
          size: big.length,
          mime: "text/plain",
          pasted: big,
        },
      ],
    };
    const fitted = fitChatDraft(draft);
    expect(chatDraftBytes(fitted)).toBeLessThanOrEqual(CHAT_DRAFT_MAX_BYTES);
    expect(fitted.text).toBe("keep me");
    expect(fitted.links).toEqual(["https://example.com"]);
    expect(fitted.pinIds).toEqual(["pin"]);
    expect(fitted.files.map((f) => f.name)).toEqual([
      "a.png",
      "pasted.txt",
      "pasted-2.txt",
    ]);
    // Only the paste that had to go went; the smaller one is still whole.
    expect(fitted.files[2]!.pasted).toBeNull();
    expect(fitted.files[1]!.pasted).toBe(medium);
    expect(fitted.files[0]!.pasted).toBeUndefined();
    // The input was not mutated.
    expect(draft.files[2]!.pasted).toBe(big);
  });

  it("drops every pasted body when one is not enough", () => {
    const half = "z".repeat(CHAT_DRAFT_MAX_BYTES);
    const draft: ChatComposerDraft = {
      text: "",
      links: [],
      pinIds: [],
      files: [
        {
          name: "pasted.txt",
          size: half.length,
          mime: "text/plain",
          pasted: half,
        },
        {
          name: "pasted-2.txt",
          size: half.length,
          mime: "text/plain",
          pasted: half,
        },
      ],
    };
    const fitted = fitChatDraft(draft);
    expect(fitted.files.every((f) => f.pasted === null)).toBe(true);
    expect(chatDraftBytes(fitted)).toBeLessThanOrEqual(CHAT_DRAFT_MAX_BYTES);
  });

  it("drops links, longest first, when there is no pasted body to drop", () => {
    // 20 000 UTF-16 units of 4-byte text (40 KB) plus twenty 2 048-char
    // links: over the cap with nothing pasted at all.
    const text = "😀".repeat(10_000);
    const links = Array.from(
      { length: 20 },
      (_, i) =>
        `https://example.com/${String(i).padStart(2, "0")}/` +
        "l".repeat(2_048 - 25 - (i === 7 ? 0 : 1))
    );
    const draft: ChatComposerDraft = {
      text,
      links,
      pinIds: ["pin"],
      files: [{ name: "a.png", size: 1, mime: "image/png" }],
    };
    expect(chatDraftBytes(draft)).toBeGreaterThan(CHAT_DRAFT_MAX_BYTES);
    const fitted = fitChatDraft(draft);
    expect(chatDraftBytes(fitted)).toBeLessThanOrEqual(CHAT_DRAFT_MAX_BYTES);
    expect(fitted.text).toBe(text);
    expect(fitted.pinIds).toEqual(["pin"]);
    expect(fitted.files).toEqual(draft.files);
    // The one link that was a character longer went first; the survivors
    // keep their order.
    expect(fitted.links.length).toBeLessThan(links.length);
    expect(fitted.links.length).toBeGreaterThan(0);
    expect(fitted.links).not.toContain(links[7]);
    expect(fitted.links).toEqual(
      links.filter((link) => fitted.links.includes(link))
    );
    expect(draft.links).toHaveLength(20);
  });

  it("cuts the text last, at a code-point boundary, and marks the cut", () => {
    // 20 000 code points of 4-byte text: 80 KB on its own. (Beyond what
    // the field lets through; the bound has to hold regardless.)
    const text = "😀".repeat(20_000);
    const draft: ChatComposerDraft = {
      text,
      links: ["https://example.com"],
      pinIds: [],
      files: [],
    };
    const fitted = fitChatDraft(draft);
    expect(chatDraftBytes(fitted)).toBeLessThanOrEqual(CHAT_DRAFT_MAX_BYTES);
    expect(fitted.links).toEqual([]);
    expect(fitted.text.endsWith(CHAT_DRAFT_TRUNCATED_MARKER)).toBe(true);
    const kept = fitted.text.slice(0, -CHAT_DRAFT_TRUNCATED_MARKER.length);
    expect(kept.length).toBeGreaterThan(0);
    expect(text.startsWith(kept)).toBe(true);
    // Whole emoji only: no lone surrogate at the cut.
    expect(kept.length % 2).toBe(0);
    expect(kept).toBe([...kept].join(""));
    // As much as fits: one more code point would not.
    expect(
      chatDraftBytes({
        ...fitted,
        text: text.slice(0, kept.length + 2) + CHAT_DRAFT_TRUNCATED_MARKER,
      })
    ).toBeGreaterThan(CHAT_DRAFT_MAX_BYTES);
  });

  it("holds the bound for any input, even one nothing in the UI can produce", () => {
    const draft: ChatComposerDraft = {
      text: "x".repeat(CHAT_DRAFT_MAX_BYTES),
      links: ["https://example.com/" + "y".repeat(CHAT_DRAFT_MAX_BYTES)],
      pinIds: ["p".repeat(CHAT_DRAFT_MAX_BYTES)],
      files: [
        { name: "n".repeat(CHAT_DRAFT_MAX_BYTES), size: 1, mime: "" },
        {
          name: "pasted.txt",
          size: 1,
          mime: "text/plain",
          pasted: "z".repeat(CHAT_DRAFT_MAX_BYTES),
        },
      ],
    };
    const fitted = fitChatDraft(draft);
    expect(chatDraftBytes(fitted)).toBeLessThanOrEqual(CHAT_DRAFT_MAX_BYTES);
    expect(fitted.links).toEqual([]);
    expect(fitted.files).toEqual([]);
    expect(fitted.pinIds).toEqual([]);
    expect(fitted.text).toBe("");
  });
});
