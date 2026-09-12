import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@dispatch/shared";

import {
  assembleTurns,
  groupTurnRows,
  loadQueued,
  toTurnEntry,
  type TurnSourceRow,
} from "../src/chat/turns.js";

let seq = 0;
const at = (s: number) => new Date(Date.UTC(2026, 8, 4, 10, 0, s));
function row(
  kind: TurnSourceRow["kind"],
  payload: Record<string, unknown>,
  s: number,
  settledAt?: number,
  key: string | null = null
): TurnSourceRow {
  seq += 1;
  return {
    id: seq,
    seq,
    kind,
    key,
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

  it("reads a cancelled turn as interrupted, not complete", () => {
    const rows: TurnSourceRow[] = [
      row(
        "turn",
        {
          state: "settled",
          prompt: { source: "system", text: "p" },
          stopReason: "cancelled",
          endedAt: at(2).toISOString(),
        },
        0,
        2
      ),
      row("assistant", { text: "half", streaming: false }, 1),
    ];
    const turns = assembleTurns(rows, new Map());
    expect(turns[0].trace.finalResult).toBe("interrupted");
    expect(turns[0].error).toBeUndefined();
    expect(turns[0].result?.text).toBe("half");
  });

  it("nests a subagent's steps under the parent Task step", () => {
    seq = 0;
    const rows = [
      row(
        "turn",
        {
          state: "settled",
          prompt: { source: "system", text: "go" },
          stopReason: "end_turn",
          endedAt: at(9).toISOString(),
        },
        0,
        9
      ),
      row(
        "tool_call",
        {
          toolKind: "other",
          title: "Task",
          status: "completed",
          locations: [],
          diff: null,
          terminalOutput: null,
        },
        1,
        8,
        "task_1"
      ),
      row(
        "tool_call",
        {
          toolKind: "read",
          title: "Read",
          status: "completed",
          locations: [{ path: "a.ts" }],
          diff: null,
          terminalOutput: null,
          parentToolCallId: "task_1",
        },
        2,
        3,
        "child_1"
      ),
      row(
        "tool_call",
        {
          toolKind: "execute",
          title: "bash",
          status: "completed",
          locations: [],
          diff: null,
          terminalOutput: "ok",
          parentToolCallId: "task_1",
        },
        4,
        5,
        "child_2"
      ),
      row(
        "tool_call",
        {
          toolKind: "edit",
          title: "Edit",
          status: "completed",
          locations: [],
          diff: null,
          terminalOutput: null,
        },
        6,
        7,
        "top_2"
      ),
    ];
    const [turn] = assembleTurns(rows, new Map());
    expect(turn.trace.steps.map((s) => s.label)).toEqual(["Task", "Edit"]);
    expect(turn.trace.steps[0].children?.map((s) => s.label)).toEqual([
      "Read",
      "bash",
    ]);
    expect(turn.trace.steps[0].children?.[0].detail.parentToolCallId).toBe(
      "task_1"
    );
    expect(turn.trace.steps[1].children).toBeUndefined();
  });

  it("keeps a child whose parent is not in the turn at the top level", () => {
    seq = 0;
    const rows = [
      row(
        "turn",
        {
          state: "settled",
          prompt: { source: "system", text: "go" },
          stopReason: "end_turn",
          endedAt: at(2).toISOString(),
        },
        0,
        2
      ),
      row(
        "tool_call",
        {
          toolKind: "read",
          title: "Read",
          status: "completed",
          locations: [],
          diff: null,
          terminalOutput: null,
          parentToolCallId: "gone",
        },
        1,
        1,
        "orphan"
      ),
    ];
    const [turn] = assembleTurns(rows, new Map());
    expect(turn.trace.steps.map((s) => s.label)).toEqual(["Read"]);
  });

  it("carries the newest plan and the turn's usage", () => {
    seq = 0;
    const rows = [
      row(
        "turn",
        {
          state: "settled",
          prompt: { source: "system", text: "go" },
          stopReason: "end_turn",
          endedAt: at(5).toISOString(),
          usage: {
            used: 4200,
            size: 200000,
            cost: { amount: 0.5, currency: "USD" },
          },
        },
        0,
        5
      ),
      row(
        "plan",
        {
          entries: [
            { content: "a", status: "completed", priority: "high" },
            { content: "b", status: "in_progress", priority: "low" },
          ],
        },
        1,
        4,
        "plan:1"
      ),
      row("assistant", { text: "done", streaming: false }, 2),
    ];
    const [turn] = assembleTurns(rows, new Map());
    expect(turn.plan).toEqual([
      { content: "a", status: "completed", priority: "high" },
      { content: "b", status: "in_progress", priority: "low" },
    ]);
    expect(turn.usage).toEqual({ used: 4200, size: 200000, costUsd: 0.5 });
    expect(turn.trace.steps).toEqual([]);
  });

  it("reports no cost for a cost the engine gave in another currency", () => {
    seq = 0;
    const rows = [
      row(
        "turn",
        {
          state: "settled",
          prompt: { source: "system", text: "go" },
          stopReason: "end_turn",
          endedAt: at(1).toISOString(),
          usage: {
            used: 10,
            size: 100,
            cost: { amount: 2.5, currency: "EUR" },
          },
        },
        0,
        1
      ),
    ];
    const [turn] = assembleTurns(rows, new Map());
    expect(turn.usage).toEqual({ used: 10, size: 100, costUsd: null });
  });

  it("reports usage without cost as costUsd null", () => {
    seq = 0;
    const rows = [
      row(
        "turn",
        {
          state: "settled",
          prompt: { source: "system", text: "go" },
          stopReason: "end_turn",
          endedAt: at(1).toISOString(),
          usage: { used: 10, size: 100 },
        },
        0,
        1
      ),
    ];
    const [turn] = assembleTurns(rows, new Map());
    expect(turn.usage).toEqual({ used: 10, size: 100, costUsd: null });
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

describe("loadQueued", () => {
  it("joins chat text onto queued chat prompts and passes the rest through", async () => {
    // A real chat id: the read casts these to uuid, so an ill-formed one is
    // dropped before the query rather than handed to Postgres.
    const CHAT_ID = "fae1f052-5d66-4039-9bde-35ac8166695d";
    const message = chatMsg(CHAT_ID, "second thoughts");
    const db = {
      query: async (_sql: string, params?: unknown[]) => {
        // Scoped to the agent: a chat id parsed out of embedded text must
        // not join another agent's message.
        expect(params).toEqual(["a", [CHAT_ID]]);
        return {
          rows: [
            {
              id: message.id,
              agent_id: "a",
              author_kind: "user",
              kind: "reply",
              text: message.text,
              reply_to: null,
              question: null,
              answer: null,
              attachments: [],
              delivered: null,
              delivery_text: null,
              read_at: null,
              origin: null,
              created_at: at(0),
              updated_at: at(0),
            },
          ],
          rowCount: 1,
        };
      },
    };
    const queued = await loadQueued(db as never, "a", [
      {
        id: CHAT_ID,
        source: { source: "chat", chatMessageId: CHAT_ID },
        createdAt: at(1).toISOString(),
      },
      {
        id: "q_1",
        source: {
          source: "agent",
          senderId: "agt_r",
          senderName: "Reviewer",
          text: "also this",
        },
        createdAt: at(2).toISOString(),
      },
    ]);
    expect(queued).toEqual([
      {
        id: CHAT_ID,
        source: "chat",
        text: "second thoughts",
        chatMessageId: CHAT_ID,
        attachments: [],
        createdAt: at(1).toISOString(),
      },
      {
        id: "q_1",
        source: "agent",
        text: "also this",
        senderAgentId: "agt_r",
        senderName: "Reviewer",
        attachments: [],
        createdAt: at(2).toISOString(),
      },
    ]);
  });

  it("skips the chat read when every queued chat id is ill-formed", async () => {
    // Otherwise the `::uuid[]` cast throws and this agent's turns read 500
    // from then on, because the offending prompt row is persisted.
    const db = {
      query: async () => {
        throw new Error("should not query");
      },
    };
    expect(
      await loadQueued(db as never, "a", [
        {
          id: "0".repeat(36),
          source: { source: "chat", chatMessageId: "0".repeat(36) },
          createdAt: at(1).toISOString(),
        },
      ])
    ).toEqual([
      {
        id: "0".repeat(36),
        source: "chat",
        text: "",
        chatMessageId: "0".repeat(36),
        attachments: [],
        createdAt: at(1).toISOString(),
      },
    ]);
  });

  it("skips the chat read when nothing queued came from chat", async () => {
    const db = {
      query: async () => {
        throw new Error("should not query");
      },
    };
    expect(await loadQueued(db as never, "a", [])).toEqual([]);
  });
});

describe("assembleTurns thinking", () => {
  it("marks the newest thought of a live turn as running, and times settled ones", () => {
    seq = 0;
    const live = assembleTurns(
      [
        row(
          "turn",
          { state: "started", prompt: { source: "system", text: "go" } },
          0
        ),
        row(
          "tool_call",
          { toolKind: "read", title: "read", status: "completed" },
          1,
          2
        ),
        row("thought", { text: "" }, 3, 5),
      ],
      new Map()
    );
    const steps = live[0].trace.steps;
    expect(steps.map((s) => [s.kind, s.status])).toEqual([
      ["read", "ok"],
      ["think", "running"],
    ]);
    expect(steps[1].endedAt).toBeUndefined();

    seq = 0;
    const settled = assembleTurns(
      [
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
        row("thought", { text: "hmm" }, 3, 7),
        row("assistant", { text: "done", streaming: false }, 8),
      ],
      new Map()
    );
    const think = settled[0].trace.steps[0];
    expect(think).toMatchObject({ kind: "think", status: "ok", durMs: 4000 });
  });
});

describe("groupTurnRows", () => {
  it("cuts at each turn row and keeps rows before the first one in their own group", () => {
    seq = 0;
    const early = row("assistant", { text: "before", streaming: false }, 0);
    const first = row(
      "turn",
      { state: "settled", prompt: { source: "system", text: "one" } },
      1,
      3
    );
    const inFirst = row("assistant", { text: "a", streaming: false }, 2);
    const second = row(
      "turn",
      { state: "started", prompt: { source: "system", text: "two" } },
      4
    );
    const groups = groupTurnRows([early, first, inFirst, second]);
    expect(groups).toHaveLength(3);
    expect(groups[0]).toEqual({ turn: null, rows: [early] });
    expect(groups[1]).toEqual({ turn: first, rows: [inFirst] });
    expect(groups[2]).toEqual({ turn: second, rows: [] });
  });

  it("indexes one to one with assembleTurns over the same rows", () => {
    seq = 0;
    const rows = [
      row("thought", { text: "hmm" }, 0),
      row(
        "turn",
        { state: "settled", prompt: { source: "system", text: "p" } },
        1,
        2
      ),
    ];
    // Comparing the two lengths cannot fail: assembleTurns maps over
    // groupTurnRows, so the counts agree for every input. What toTurnEntry
    // actually relies on is the pairing, since it takes `id` from the turn
    // and `at`/`updatedAt`/`settled` from the group at the same index.
    const groups = groupTurnRows(rows);
    const turns = assembleTurns(rows, new Map());
    expect(turns).toHaveLength(groups.length);
    expect(turns.map((t) => t.id)).toEqual(
      groups.map((g) =>
        g.turn ? `turn:${g.turn.id}` : `turn:pre:${g.rows[0].id}`
      )
    );
  });
});

describe("toTurnEntry", () => {
  it("anchors the entry on the turn row and moves updatedAt with the newest row", () => {
    seq = 0;
    const turnRow = row(
      "turn",
      {
        state: "started",
        prompt: { source: "system", text: "p" },
      },
      1
    );
    const chunk = row("assistant", { text: "so far", streaming: true }, 2, 7);
    const [group] = groupTurnRows([turnRow, chunk]);
    const [turn] = assembleTurns([turnRow, chunk], new Map());
    const entry = toTurnEntry(turn, group, "agt_x");
    expect(entry).toMatchObject({
      type: "turn",
      id: `turn:${turnRow.id}`,
      agentId: "agt_x",
      at: at(1).toISOString(),
      updatedAt: at(7).toISOString(),
      settled: false,
      interrupted: false,
      result: { text: "so far", streaming: true },
    });
    expect(entry.error).toBeUndefined();
  });

  it("gives a pre-turn group the first row's id and reads it as settled", () => {
    seq = 0;
    const early = row("assistant", { text: "history", streaming: false }, 0, 1);
    const [group] = groupTurnRows([early]);
    const [turn] = assembleTurns([early], new Map());
    const entry = toTurnEntry(turn, group, "agt_x");
    expect(entry.id).toBe(`turn:pre:${early.id}`);
    expect(entry.settled).toBe(true);
    expect(entry.at).toBe(at(0).toISOString());
  });

  it("reads a cancelled turn as interrupted", () => {
    seq = 0;
    const turnRow = row(
      "turn",
      {
        state: "settled",
        prompt: { source: "system", text: "p" },
        stopReason: "cancelled",
        endedAt: at(2).toISOString(),
      },
      0,
      2
    );
    const [group] = groupTurnRows([turnRow]);
    const [turn] = assembleTurns([turnRow], new Map());
    const entry = toTurnEntry(turn, group, "agt_x");
    expect(entry.interrupted).toBe(true);
    expect(entry.settled).toBe(true);
    expect(entry.trace.finalResult).toBe("interrupted");
  });

  it("reads a turn the service went down under as interrupted, not failed", () => {
    seq = 0;
    const turnRow = row(
      "turn",
      {
        state: "settled",
        prompt: { source: "system", text: "p" },
        error: "interrupted by restart",
        endedAt: at(4).toISOString(),
      },
      0,
      4
    );
    const [group] = groupTurnRows([turnRow]);
    const [turn] = assembleTurns([turnRow], new Map());
    const entry = toTurnEntry(turn, group, "agt_x");
    expect(entry.interrupted).toBe(true);
    expect(entry.trace.finalResult).toBe("interrupted");
    // The restart marker is not an engine failure, so it does not also
    // render as an error line under the result.
    expect(entry.error).toBeUndefined();
  });

  it("carries an engine error through and turns questions into references", () => {
    seq = 0;
    const turnRow = row(
      "turn",
      {
        state: "settled",
        prompt: { source: "system", text: "p" },
        error: "no API key",
        endedAt: at(5).toISOString(),
      },
      0,
      5
    );
    const question = {
      id: "11111111-1111-4111-8111-111111111111",
      agentId: "agt_x",
      authorKind: "agent" as const,
      kind: "question" as const,
      text: "Which one?",
      replyTo: null,
      question: { options: [{ label: "A" }], allowFreeform: true },
      answer: null,
      attachments: [],
      delivered: null,
      readAt: null,
      createdAt: at(1).toISOString(),
      updatedAt: at(1).toISOString(),
    };
    const [group] = groupTurnRows([turnRow]);
    const [turn] = assembleTurns([turnRow], new Map(), [question as never]);
    const entry = toTurnEntry(turn, group, "agt_x");
    expect(entry.error).toBe("no API key");
    expect(entry.interrupted).toBe(false);
    expect(entry.questions).toEqual([
      { messageId: "11111111-1111-4111-8111-111111111111", answered: false },
    ]);
  });
});
