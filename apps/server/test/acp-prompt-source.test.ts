import { describe, expect, it } from "vitest";

import { parsePromptSource } from "../src/agents/acp/prompt-source.js";

describe("parsePromptSource", () => {
  it("reads the block id out of a POST envelope, whoever it is from", () => {
    for (const from of [
      "user",
      "Reviewer (agt_683b115bc1e9)",
      "Odd (name) here",
    ]) {
      const text = [
        `--- DISPATCH POST (id: fae1f052-5d66-4039-9bde-35ac8166695d, from: ${from}) ---`,
        "hello",
        "--- END DISPATCH POST ---",
        "Your reply appears in the stream…",
      ].join("\n");
      expect(parsePromptSource(text), from).toEqual({
        source: "chat",
        chatMessageId: "fae1f052-5d66-4039-9bde-35ac8166695d",
      });
    }
    // A header without a sender still names its block.
    expect(
      parsePromptSource(
        "--- DISPATCH POST (id: fae1f052-5d66-4039-9bde-35ac8166695d) ---\nhi\n--- END DISPATCH POST ---"
      )
    ).toEqual({
      source: "chat",
      chatMessageId: "fae1f052-5d66-4039-9bde-35ac8166695d",
    });
    // The retired CHAT marker is no longer a prompt source.
    expect(
      parsePromptSource(
        "--- DISPATCH CHAT (id: fae1f052-5d66-4039-9bde-35ac8166695d) ---\nhi\n--- END DISPATCH CHAT ---"
      ).source
    ).toBe("system");
  });

  it("does not read a block id out of a header that is not a real UUID", () => {
    // The header is matched on every prompt that reaches the queue, review
    // injection prompts included, and those embed feedback bodies verbatim.
    // A captured value that is not a UUID reaches a `::uuid[]` cast and
    // turns every later read of that agent's turns into a 500.
    for (const id of [
      "0".repeat(36),
      "-".repeat(36),
      "fae1f052-5d664039-9bde-35ac8166695dd",
    ]) {
      const text = [
        `--- DISPATCH POST (id: ${id}, from: user) ---`,
        "hello",
        "--- END DISPATCH POST ---",
      ].join("\n");
      expect(parsePromptSource(text).source).toBe("system");
    }
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
