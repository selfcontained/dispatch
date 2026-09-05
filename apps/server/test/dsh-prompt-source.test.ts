import { describe, expect, it } from "vitest";

import { parsePromptSource } from "../src/agents/dsh/prompt-source.js";

describe("parsePromptSource", () => {
  it("reads the chat message id out of a chat envelope", () => {
    const text = [
      "--- DISPATCH CHAT (id: fae1f052-5d66-4039-9bde-35ac8166695d) ---",
      "hello",
      "--- END DISPATCH CHAT ---",
      "The user is reading Chat…",
    ].join("\n");
    expect(parsePromptSource(text)).toEqual({
      source: "chat",
      chatMessageId: "fae1f052-5d66-4039-9bde-35ac8166695d",
    });
  });

  it("reads sender and text out of a cross-agent message envelope", () => {
    const body = JSON.stringify({
      from: "Dispatch Harness Research",
      senderId: "agt_683b115bc1e9",
      senderRelation: "unrelated",
      message: "Quick check: which branch?",
      replyTarget: "agt_683b115bc1e9",
    });
    const text = `--- DISPATCH MESSAGE ---\n${body}\n--- END MESSAGE ---\nOptional reply channel…`;
    expect(parsePromptSource(text)).toEqual({
      source: "agent",
      senderId: "agt_683b115bc1e9",
      senderName: "Dispatch Harness Research",
      text: "Quick check: which branch?",
    });
  });

  it("keeps the first 500 characters of anything else as a system prompt", () => {
    const text = "x".repeat(600);
    expect(parsePromptSource(text)).toEqual({
      source: "system",
      text: "x".repeat(500),
    });
  });
});
