// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  CHAT_DRAFT_MAX_BYTES,
  EMPTY_CHAT_DRAFT,
  fitChatDraft,
} from "@/lib/chat-draft";
import {
  CHAT_DRAFT_STORAGE_PREFIX,
  CHAT_PENDING_DRAFT_STORAGE_PREFIX,
} from "@/lib/store";
import { readChatRecoveryState } from "./chat-post-recovery";

afterEach(() => window.localStorage.clear());

describe("pending post recovery", () => {
  it("keeps the full live pasted body when storage is its capped snapshot", () => {
    const body = "x".repeat(CHAT_DRAFT_MAX_BYTES + 10);
    const live = {
      text: "next draft",
      links: [],
      files: [
        {
          name: "pasted.txt",
          size: body.length,
          mime: "text/plain",
          pasted: body,
        },
      ],
    };
    const snapshot = fitChatDraft(live);
    expect(snapshot.files[0].pasted).toBeNull();
    window.localStorage.setItem(
      CHAT_DRAFT_STORAGE_PREFIX + "agent",
      JSON.stringify(snapshot)
    );
    window.localStorage.setItem(
      CHAT_PENDING_DRAFT_STORAGE_PREFIX + "agent",
      JSON.stringify({ orphan: EMPTY_CHAT_DRAFT })
    );
    expect(readChatRecoveryState("agent", {}, live).draft).toBe(live);
  });
  it("uses a previous tab's persisted recovery marker instead of a stale cached snapshot", () => {
    const snapshot = { ...EMPTY_CHAT_DRAFT, text: "original" };
    const recovered = { ...EMPTY_CHAT_DRAFT, text: "original\n\nnext draft" };
    window.localStorage.setItem(
      CHAT_PENDING_DRAFT_STORAGE_PREFIX + "agent",
      JSON.stringify({ post: null })
    );
    window.localStorage.setItem(
      CHAT_DRAFT_STORAGE_PREFIX + "agent",
      JSON.stringify(recovered)
    );
    const result = readChatRecoveryState(
      "agent",
      { post: snapshot },
      { ...EMPTY_CHAT_DRAFT, text: "next draft" }
    );
    expect(result.pending.post).toBeNull();
    expect(result.draft).toEqual(recovered);
  });

  it("reads the newest draft alongside an orphan before merging", () => {
    const snapshot = { ...EMPTY_CHAT_DRAFT, text: "original" };
    const current = { ...EMPTY_CHAT_DRAFT, text: "newer typing" };
    window.localStorage.setItem(
      CHAT_PENDING_DRAFT_STORAGE_PREFIX + "agent",
      JSON.stringify({ post: snapshot })
    );
    window.localStorage.setItem(
      CHAT_DRAFT_STORAGE_PREFIX + "agent",
      JSON.stringify(current)
    );
    expect(readChatRecoveryState("agent", {}, EMPTY_CHAT_DRAFT)).toEqual({
      pending: { post: snapshot },
      draft: current,
    });
  });
});
