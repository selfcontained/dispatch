import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@dispatch/shared";

import { assembleTurns, type TurnSourceRow } from "../src/agents/dsh/turns.js";

let seq = 0;
const at = (s: number) => new Date(Date.UTC(2026, 8, 4, 10, 0, s));
function row(
  kind: TurnSourceRow["kind"],
  payload: Record<string, unknown>,
  s: number,
  settledAt?: number
): TurnSourceRow {
  seq += 1;
  return {
    id: seq,
    seq,
    kind,
    payload,
    createdAt: at(s),
    updatedAt: at(settledAt ?? s),
  };
}
const chatMsg = (id: string, text: string, origin?: "launch"): ChatMessage => ({
  id,
  agentId: "a",
  authorKind: "user",
  kind: "reply",
  text,
  replyTo: null,
  question: null,
  answer: null,
  attachments: [],
  delivered: true,
  readAt: null,
  ...(origin ? { origin } : {}),
  createdAt: at(0).toISOString(),
  updatedAt: at(0).toISOString(),
});

describe("assembleTurns", () => {
  it("cuts the stream into turns with prompt, steps, and result", () => {
    seq = 0;
    const rows = [
      row(
        "turn",
        {
          state: "settled",
          prompt: { source: "chat", chatMessageId: "m1" },
          stopReason: "end_turn",
          endedAt: at(9).toISOString(),
        },
        0,
        9
      ),
      row("assistant", { text: "Let me look.", streaming: false }, 1),
      row(
        "tool_call",
        {
          toolKind: "other",
          title: "mcp__dispatch__dispatch_event",
          status: "completed",
          locations: [],
          diff: null,
          terminalOutput: "ok",
        },
        2,
        2
      ),
      row(
        "tool_call",
        {
          toolKind: "execute",
          title: "bash",
          status: "completed",
          locations: [],
          diff: null,
          terminalOutput: "a\nb\n",
        },
        3,
        5
      ),
      row("thought", { text: "reasoning" }, 6),
      row("assistant", { text: "Done: two files.", streaming: false }, 8),
      row(
        "turn",
        { state: "started", prompt: { source: "system", text: "again" } },
        10
      ),
      row("assistant", { text: "Work", streaming: true }, 11),
    ];
    const turns = assembleTurns(
      rows,
      new Map([["m1", chatMsg("m1", "look please")]])
    );
    expect(turns).toHaveLength(2);
    const [first, second] = turns;
    expect(first.prompt).toMatchObject({
      source: "chat",
      text: "look please",
      chatMessageId: "m1",
    });
    expect(first.trace.finalResult).toBe("ok");
    expect(first.trace.steps.map((s) => [s.kind, s.label, s.status])).toEqual([
      ["note", "Let me look.", "ok"],
      ["execute", "bash", "ok"],
      ["think", "thinking", "ok"],
    ]);
    expect(first.trace.steps[1].durMs).toBe(2000);
    expect(first.result).toEqual({
      text: "Done: two files.",
      streaming: false,
    });
    expect(second.prompt).toEqual({
      source: "system",
      text: "again",
      attachments: [],
    });
    expect(second.trace.endedAt).toBeUndefined();
    expect(second.result).toEqual({ text: "Work", streaming: true });
  });

  it("marks a launch post and a cross-agent message by source", () => {
    seq = 0;
    const rows = [
      row(
        "turn",
        {
          state: "settled",
          prompt: { source: "chat", chatMessageId: "L" },
          endedAt: at(1).toISOString(),
        },
        0,
        1
      ),
      row(
        "turn",
        {
          state: "settled",
          prompt: {
            source: "agent",
            senderId: "agt_x",
            senderName: "Reviewer",
            text: "hi",
          },
          endedAt: at(3).toISOString(),
        },
        2,
        3
      ),
    ];
    const turns = assembleTurns(
      rows,
      new Map([["L", chatMsg("L", "launch text", "launch")]])
    );
    expect(turns[0].prompt.source).toBe("launch");
    expect(turns[1].prompt).toMatchObject({
      source: "agent",
      senderName: "Reviewer",
      text: "hi",
    });
  });

  it("folds rows before the first turn row into one synthetic turn and carries a settle error", () => {
    seq = 0;
    const rows = [
      row(
        "tool_call",
        {
          toolKind: "read",
          title: "read",
          status: "failed",
          locations: [{ path: "x" }],
          diff: null,
          terminalOutput: null,
        },
        0,
        1
      ),
      row(
        "turn",
        {
          state: "settled",
          prompt: { source: "system", text: "p" },
          error: "no API key",
          endedAt: at(3).toISOString(),
        },
        2,
        3
      ),
      row("status", { message: "no API key" }, 3),
    ];
    const turns = assembleTurns(rows, new Map());
    expect(turns[0].prompt).toEqual({
      source: "system",
      text: "Earlier activity",
      attachments: [],
    });
    expect(turns[0].trace.steps[0]).toMatchObject({
      kind: "read",
      status: "error",
    });
    expect(turns[0].trace.finalResult).toBe("ok");
    expect(turns[1].error).toBe("no API key");
    expect(turns[1].trace.finalResult).toBe("error");
  });
});

describe("assembleTurns with agent questions", () => {
  it("carries a question on the turn it was asked in, with its answer state", () => {
    const rows = [
      row(
        "turn",
        {
          state: "settled",
          prompt: { source: "system", text: "first" },
          endedAt: at(5).toISOString(),
        },
        0,
        5
      ),
      row("assistant", { text: "Which one?", streaming: false }, 2),
      row(
        "turn",
        {
          state: "settled",
          prompt: { source: "system", text: "second" },
          endedAt: at(12).toISOString(),
        },
        10,
        12
      ),
    ];
    const question = {
      id: "q1",
      agentId: "agt_1",
      authorKind: "agent" as const,
      kind: "question" as const,
      text: "Scope choice: fix the preview alone, or bundle it?",
      replyTo: null,
      question: {
        options: [
          { label: "Preview only" },
          { label: "Bundle", value: "bundle" },
        ],
        allowFreeform: true,
      },
      answer: null,
      attachments: [],
      delivered: null,
      readAt: null,
      createdAt: at(3).toISOString(),
      updatedAt: at(3).toISOString(),
    };
    const turns = assembleTurns(rows, new Map(), [question as never]);
    expect(turns[0].questions).toEqual([
      {
        id: "q1",
        text: "Scope choice: fix the preview alone, or bundle it?",
        options: [
          { label: "Preview only" },
          { label: "Bundle", value: "bundle" },
        ],
        allowFreeform: true,
        answer: null,
        createdAt: at(3).toISOString(),
      },
    ]);
    expect(turns[1].questions).toBeUndefined();
  });
});

describe("assembleTurns labels", () => {
  it("labels a turn with the agent's last terminal dispatch_event message", () => {
    const rows = [
      row(
        "turn",
        {
          state: "settled",
          prompt: { source: "system", text: "go" },
          endedAt: at(9).toISOString(),
        },
        0,
        9
      ),
      row(
        "tool_call",
        {
          title: "mcp__dispatch__dispatch_event",
          toolKind: "other",
          status: "completed",
          locations: [],
          diff: null,
          terminalOutput: "ok",
          input: { type: "working", message: "Reading README.md" },
        },
        1
      ),
      row(
        "tool_call",
        {
          title: "read",
          toolKind: "read",
          status: "completed",
          locations: [],
          diff: null,
          terminalOutput: "x",
        },
        2
      ),
      row(
        "tool_call",
        {
          title: "mcp__dispatch__dispatch_event",
          toolKind: "other",
          status: "completed",
          locations: [],
          diff: null,
          terminalOutput: "ok",
          input: { type: "idle", message: "Answered README question" },
        },
        3
      ),
    ];
    const turns = assembleTurns(rows, new Map());
    expect(turns[0].label).toBe("Answered README question");
    // The status calls themselves stay out of the steps.
    expect(turns[0].trace.steps.map((s) => s.kind)).toEqual(["read"]);
  });

  it("falls back to the last working message, and to nothing", () => {
    const working = [
      row(
        "turn",
        {
          state: "settled",
          prompt: { source: "system", text: "go" },
          endedAt: at(2).toISOString(),
        },
        0,
        2
      ),
      row(
        "tool_call",
        {
          title: "mcp__dispatch__dispatch_event",
          toolKind: "other",
          status: "completed",
          locations: [],
          diff: null,
          terminalOutput: "ok",
          input: { type: "working", message: "Checking the tree" },
        },
        1
      ),
    ];
    expect(assembleTurns(working, new Map())[0].label).toBe(
      "Checking the tree"
    );
    const none = [
      row(
        "turn",
        {
          state: "settled",
          prompt: { source: "system", text: "go" },
          endedAt: at(1).toISOString(),
        },
        0,
        1
      ),
    ];
    expect(assembleTurns(none, new Map())[0].label).toBeUndefined();
  });
});
