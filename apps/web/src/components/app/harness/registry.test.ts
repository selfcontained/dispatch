import { describe, expect, it } from "vitest";

import type { Step, Turn } from "./contracts";
import {
  argsSummary,
  hasDetail,
  latestPlanItems,
  stepLabel,
  stepSummary,
  toolName,
  turnLabelFromSteps,
  unwrapReadOutput,
} from "./registry";

function step(partial: Partial<Step> & Pick<Step, "kind">): Step {
  return {
    id: "s",
    status: "ok",
    startedAt: 0,
    label: partial.kind,
    ...partial,
  };
}

describe("toolName", () => {
  it("splits an MCP tool title into server and name", () => {
    expect(toolName("mcp__dispatch__dispatch_rename_session")).toEqual({
      name: "dispatch_rename_session",
      server: "dispatch",
    });
    expect(toolName("bash")).toEqual({ name: "bash" });
  });
});

describe("stepLabel", () => {
  it("uses the tool's own name over the kind", () => {
    expect(
      stepLabel(step({ kind: "other", label: "mcp__dispatch__dispatch_event" }))
    ).toBe("dispatch_event");
    expect(stepLabel(step({ kind: "execute", label: "bash" }))).toBe("bash");
    expect(stepLabel(step({ kind: "think", label: "" }))).toBe("thinking");
  });
});

describe("stepSummary", () => {
  it("shows the command for an execute step, never the output", () => {
    const s = step({
      kind: "execute",
      label: "bash",
      detail: { input: { command: "ls apps" }, terminalOutput: "web\nserver" },
    });
    expect(stepSummary(s)).toBe("ls apps");
    expect(
      stepSummary(
        step({
          kind: "execute",
          label: "bash",
          detail: { terminalOutput: "x" },
        })
      )
    ).toBeUndefined();
  });

  it("names the file for a read step", () => {
    const s = step({
      kind: "read",
      label: "read",
      detail: { locations: [{ path: "/repo/README.md", line: 12 }] },
    });
    expect(stepSummary(s)).toBe("README.md:12");
  });

  it("digests the arguments of an unknown tool", () => {
    const s = step({
      kind: "other",
      label: "mcp__dispatch__dispatch_event",
      detail: { input: { type: "working", message: "Reading README.md" } },
    });
    expect(stepSummary(s)).toBe("type: working · message: Reading README.md");
    expect(argsSummary("not an object")).toBeUndefined();
  });
});

describe("hasDetail", () => {
  it("is false for a read step with nothing under it", () => {
    expect(
      hasDetail(
        step({ kind: "read", label: "read", detail: { locations: [] } })
      )
    ).toBe(false);
    expect(
      hasDetail(
        step({ kind: "read", label: "read", detail: { terminalOutput: "x" } })
      )
    ).toBe(true);
  });

  it("needs output or arguments for an unknown tool", () => {
    expect(hasDetail(step({ kind: "other", label: "t", detail: {} }))).toBe(
      false
    );
    expect(
      hasDetail(
        step({ kind: "other", label: "t", detail: { input: { a: 1 } } })
      )
    ).toBe(true);
  });

  it("shows a running step's input before any output lands", () => {
    const detail = { input: { command: "pnpm test" }, terminalOutput: null };
    // Settled with no output there is nothing to open; running, the
    // command it is waiting on is the body.
    expect(hasDetail(step({ kind: "execute", label: "bash", detail }))).toBe(
      false
    );
    expect(
      hasDetail(
        step({ kind: "execute", label: "bash", status: "running", detail })
      )
    ).toBe(true);
    expect(
      hasDetail(
        step({
          kind: "edit",
          label: "edit",
          status: "running",
          detail: { input: { file_path: "a.ts", new_string: "x" } },
        })
      )
    ).toBe(true);
    expect(
      hasDetail(
        step({ kind: "execute", label: "bash", status: "running", detail: {} })
      )
    ).toBe(false);
  });
});

describe("unwrapReadOutput", () => {
  it("strips the read tool's path/type/content wrapper", () => {
    const wrapped =
      "<path>/r/README.md</path>\n<type>file</type>\n<content>\n1: # Dispatch\n2: hi\n</content>";
    expect(unwrapReadOutput(wrapped)).toBe("1: # Dispatch\n2: hi\n");
    expect(unwrapReadOutput("plain")).toBe("plain");
  });
});

describe("turnLabelFromSteps", () => {
  it("names the most consequential thing the turn did", () => {
    expect(
      turnLabelFromSteps([
        step({
          kind: "read",
          label: "read",
          detail: { locations: [{ path: "/r/README.md" }] },
        }),
        step({
          kind: "edit",
          label: "edit",
          detail: { diff: { path: "/r/a.ts", oldText: "", newText: "x" } },
        }),
      ])
    ).toBe("edited a.ts");
    expect(
      turnLabelFromSteps([
        step({
          kind: "execute",
          label: "bash",
          detail: { input: { command: "git status --short" } },
        }),
      ])
    ).toBe("ran git status --short");
    expect(
      turnLabelFromSteps([
        step({
          kind: "read",
          label: "read",
          detail: { locations: [{ path: "/r/README.md" }] },
        }),
      ])
    ).toBe("read README.md");
    expect(
      turnLabelFromSteps([
        step({
          kind: "other",
          label: "mcp__dispatch__brain_list_objects",
          detail: {},
        }),
      ])
    ).toBe("brain_list_objects");
    expect(turnLabelFromSteps([step({ kind: "think", label: "" })])).toBe(
      "thought it over"
    );
    expect(turnLabelFromSteps([])).toBeUndefined();
  });
});

const at = Date.parse("2026-09-07T10:00:00Z");
const assistantTurn = (plan?: unknown): Turn => ({
  id: "t:assistant",
  role: "assistant",
  content: "",
  timestamp: at,
  trace: { startedAt: at, endedAt: at + 1000, steps: [] },
  extra: plan ? { plan } : {},
});

describe("latestPlanItems", () => {
  const plan = [
    { content: "a", status: "completed", priority: "high" },
    { content: "b", status: "in_progress", priority: "low" },
  ] as const;
  it("prefers the live plan while streaming", () => {
    expect(latestPlanItems([assistantTurn(plan)], [plan[1]], true)).toEqual([
      { content: "b", status: "in_progress" },
    ]);
  });
  it("falls back to the newest assistant turn's plan", () => {
    expect(
      latestPlanItems(
        [
          assistantTurn([plan[0]]),
          { id: "u", role: "user", content: "x", timestamp: at },
          assistantTurn(plan),
        ],
        null,
        false
      )
    ).toEqual([
      { content: "a", status: "completed" },
      { content: "b", status: "in_progress" },
    ]);
  });
  it("is empty when no turn carries a plan", () => {
    expect(latestPlanItems([assistantTurn()], null, false)).toEqual([]);
  });
});

describe("stepLabel", () => {
  it("no longer special-cases a todo tool", () => {
    const step: Step = {
      id: "s",
      kind: "other",
      label: "todo_write",
      status: "ok",
      startedAt: at,
    };
    expect(stepLabel(step)).toBe("todo_write");
    expect(stepSummary(step)).toBeUndefined();
  });
});
