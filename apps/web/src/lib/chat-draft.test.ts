import { describe, expect, it } from "vitest";

import {
  CHAT_DRAFT_MAX_BYTES,
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
});
