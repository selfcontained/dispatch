import { describe, expect, it } from "vitest";

import {
  shapeSubagent,
  subagentIdFromOutput,
} from "../src/agents/dsh/subagents.js";
import type { SessionLogEvent } from "../src/agents/dsh/session-log.js";

const T0 = Date.UTC(2026, 8, 5, 10, 0, 0);
const ev = (
  type: string,
  time: number,
  data: Record<string, unknown>
): SessionLogEvent => ({ type, time: T0 + time, data });

const call = (id: string, name: string, args: unknown, t: number) =>
  ev("tool/call", t, {
    turn: 1,
    callId: id,
    name,
    arguments: JSON.stringify(args),
  });
const result = (id: string, text: string, t: number, isError = false) =>
  ev("tool/result", t, {
    turn: 1,
    message: {
      source: { kind: "tool", callId: id },
      content: [
        {
          type: "tool-result",
          toolCallId: id,
          isError,
          content: [{ type: "text", text }],
        },
      ],
    },
  });
const say = (text: string, t: number) =>
  ev("assistant/message", t, {
    turn: 1,
    message: { role: "assistant", content: [{ type: "text", text }] },
  });

describe("subagentIdFromOutput", () => {
  it("reads the child session id a subagent call reported", () => {
    expect(
      subagentIdFromOutput(
        "started subagent 44D7B69A-a278-4f0b-a7d5-2158a60b3f07"
      )
    ).toBe("44d7b69a-a278-4f0b-a7d5-2158a60b3f07");
    expect(subagentIdFromOutput("done")).toBeNull();
    expect(subagentIdFromOutput(null)).toBeNull();
  });
});

describe("shapeSubagent", () => {
  const header = {
    id: "child",
    createdAt: T0,
    parentSession: "parent",
    origin: "subagent",
  };

  it("shapes a finished child log into a turn with steps, notes and a result", () => {
    const sub = shapeSubagent("child", {
      header,
      events: [
        ev("subagent/descriptor", 0, {
          label: "Study skill conventions",
          agentProvider: "openai",
          agentModel: "gpt-5.6-sol",
        }),
        ev("turn/start", 1, { turn: 1 }),
        ev("user/message", 2, {
          content: [{ type: "text", text: "Inspect the repo" }],
        }),
        call("c1", "glob", { pattern: "**/SKILL.md" }, 10),
        result("c1", "No files found", 300),
        say("Looking further.", 400),
        call("c2", "read", { file_path: "/w/README.md" }, 500),
        result(
          "c2",
          "<path>/w/README.md</path><content>hi</content>",
          900,
          true
        ),
        say("Done: nothing to report.", 1000),
        ev("turn/end", 1100, { turn: 1, reason: { kind: "completed" } }),
      ],
    });
    expect(sub).toMatchObject({
      id: "child",
      label: "Study skill conventions",
      model: "openai/gpt-5.6-sol",
      status: "finished",
      parentSession: "parent",
      startedAt: new Date(T0).toISOString(),
      endedAt: new Date(T0 + 1100).toISOString(),
    });
    expect(sub.turns).toHaveLength(1);
    const turn = sub.turns[0];
    expect(turn.prompt).toEqual({
      source: "chat",
      text: "Inspect the repo",
      attachments: [],
    });
    expect(turn.trace.finalResult).toBe("ok");
    expect(turn.trace.steps.map((s) => [s.kind, s.label, s.status])).toEqual([
      ["search", "glob", "ok"],
      ["note", "Looking further.", "ok"],
      ["read", "read", "error"],
    ]);
    expect(turn.trace.steps[0].durMs).toBe(290);
    expect(turn.trace.steps[0].detail.terminalOutput).toBe("No files found");
    expect(turn.trace.steps[0].detail.input).toEqual({
      pattern: "**/SKILL.md",
    });
    expect(turn.trace.steps[2].detail.locations).toEqual([
      { path: "/w/README.md" },
    ]);
    expect(turn.result).toEqual({
      text: "Done: nothing to report.",
      streaming: false,
    });
  });

  it("reports a running child with its open step and streaming result", () => {
    const sub = shapeSubagent("child", {
      header,
      events: [
        ev("user/message", 2, { content: [{ type: "text", text: "go" }] }),
        call("c1", "bash", { command: "sleep 5" }, 10),
        say("Working on it.", 20),
      ],
    });
    expect(sub.status).toBe("running");
    expect(sub.endedAt).toBeUndefined();
    const turn = sub.turns[0];
    expect(turn.trace.endedAt).toBeUndefined();
    expect(turn.trace.steps.map((s) => [s.kind, s.status])).toEqual([
      ["execute", "running"],
    ]);
    expect(turn.result).toEqual({ text: "Working on it.", streaming: true });
  });

  it("is 'starting' before the first prompt and folds a mid-turn message into the prompt", () => {
    expect(shapeSubagent("child", { header, events: [] }).status).toBe(
      "starting"
    );
    const sub = shapeSubagent("child", {
      header,
      events: [
        ev("user/message", 2, { content: [{ type: "text", text: "first" }] }),
        ev("user/message", 3, {
          content: [{ type: "text", text: "and this" }],
        }),
        ev("turn/end", 4, { turn: 1, reason: { kind: "cancelled" } }),
      ],
    });
    expect(sub.turns[0].prompt.text).toBe("first\n\nand this");
    expect(sub.turns[0].trace.finalResult).toBe("error");
  });
});
