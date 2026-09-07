import { describe, expect, it } from "vitest";

import { classifyClaudeSessionEntries } from "../src/agents/provider-session-state.js";

const assistant = (stopReason: unknown): Record<string, unknown> => ({
  type: "assistant",
  message: { stop_reason: stopReason },
});
const human = (): Record<string, unknown> => ({
  type: "user",
  message: { content: "continue the task" },
});
const toolResult = (): Record<string, unknown> => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: "tool_1" }] },
});
const turnDuration = (): Record<string, unknown> => ({
  type: "system",
  subtype: "turn_duration",
  durationMs: 42,
});

describe("classifyClaudeSessionEntries", () => {
  it("recognizes an explicit provider turn-end marker", () => {
    expect(
      classifyClaudeSessionEntries([
        human(),
        assistant("end_turn"),
        turnDuration(),
      ])
    ).toEqual({ state: "complete", reason: "turn-duration" });
  });

  it("keeps completion when metadata follows turn duration", () => {
    expect(
      classifyClaudeSessionEntries([
        human(),
        assistant("end_turn"),
        turnDuration(),
        { type: "file-history-snapshot" },
      ])
    ).toEqual({ state: "complete", reason: "turn-duration" });
  });

  it("recognizes end_turn when the duration marker was not flushed", () => {
    expect(
      classifyClaudeSessionEntries([human(), assistant("end_turn")])
    ).toEqual({
      state: "complete",
      reason: "assistant-end_turn",
    });
  });

  it("recognizes a dangling provider tool call as interrupted", () => {
    expect(
      classifyClaudeSessionEntries([human(), assistant("tool_use")])
    ).toEqual({
      state: "interrupted",
      reason: "dangling-tool-use",
    });
  });

  it("recognizes a tool result without a follow-up assistant message", () => {
    expect(
      classifyClaudeSessionEntries([
        human(),
        assistant("tool_use"),
        toolResult(),
      ])
    ).toEqual({
      state: "interrupted",
      reason: "tool-result-without-follow-up",
    });
  });

  it("recognizes an unanswered human message after a previous turn", () => {
    expect(
      classifyClaudeSessionEntries([
        human(),
        assistant("end_turn"),
        turnDuration(),
        human(),
      ])
    ).toEqual({ state: "interrupted", reason: "unanswered-user-message" });
  });

  it("fails closed for an unrecognized transcript shape", () => {
    expect(classifyClaudeSessionEntries([{ type: "summary" }])).toEqual({
      state: "unknown",
      reason: "no-decisive-turn-marker",
    });
  });
});
