import { describe, expect, it } from "vitest";

import type { Step } from "./contracts";
import {
  activeStepLabel,
  runningTurnVerb,
  argsSummary,
  hasDetail,
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
    expect(toolName("mcp__dispatch__rename_session")).toEqual({
      name: "rename_session",
      server: "dispatch",
    });
    expect(toolName("bash")).toEqual({ name: "bash" });
  });
});

describe("stepLabel", () => {
  it("uses the tool's own name over the kind", () => {
    expect(
      stepLabel(step({ kind: "other", label: "mcp__dispatch__pin" }))
    ).toBe("pin");
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

  it("diffs an edit once per detail object", () => {
    const detail = {
      diff: { path: "/r/b.ts", oldText: "x\n", newText: "x\ny\n" },
    };
    const s = step({ kind: "edit", label: "edit", detail });
    expect(stepSummary(s)).toBe("b.ts +1 −0");
    // Rewriting the same object cannot change the answer: the diff ran once
    // and its summary is held against that object, off the render path.
    detail.diff.newText = "x\ny\nz\n";
    expect(stepSummary(s)).toBe("b.ts +1 −0");
    // A different detail object is a different edit, so it recomputes.
    const next = step({
      kind: "edit",
      label: "edit",
      detail: { diff: { ...detail.diff } },
    });
    expect(stepSummary(next)).toBe("b.ts +2 −0");
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
      label: "mcp__dispatch__notify",
      detail: { input: { level: "info", message: "Reading README.md" } },
    });
    expect(stepSummary(s)).toBe("level: info · message: Reading README.md");
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

  it("keeps an execute command available before and after output lands", () => {
    const detail = { input: { command: "pnpm test" }, terminalOutput: null };
    expect(hasDetail(step({ kind: "execute", label: "bash", detail }))).toBe(
      true
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

describe("truthful live activity", () => {
  const pending = step({
    kind: "other",
    label: "mcp__dispatch__post",
    status: "pending",
    startedAt: 1,
    updatedAt: 2,
    detail: { input: { to: "parent" } },
  });
  it("distinguishes partial tool input from confirmed execution", () => {
    expect(activeStepLabel([pending])).toBeUndefined();
    expect(runningTurnVerb([pending])).toBe("preparing post");
    expect(hasDetail(pending)).toBe(true);
  });
  it("does not let an abandoned pending post mask later work or later output", () => {
    const newer = step({
      kind: "execute",
      label: "bash",
      status: "running",
      startedAt: 3,
    });
    expect(runningTurnVerb([pending, newer])).toBe("bash");
    expect(
      runningTurnVerb([pending, { ...newer, status: "ok", endedAt: 4 }])
    ).toBe("thinking");
    expect(runningTurnVerb([pending], undefined, 5)).toBe("thinking");
    expect(pending.status).toBe("pending");
  });
  it("uses latest updates while retaining legitimate parallel executions", () => {
    const a = step({
      kind: "execute",
      label: "bash",
      status: "running",
      startedAt: 1,
      updatedAt: 8,
    });
    const b = step({
      kind: "read",
      label: "Read",
      status: "running",
      startedAt: 4,
      updatedAt: 5,
    });
    expect(activeStepLabel([a, b])).toBe("bash + 1 other active");
    expect(activeStepLabel([{ ...a, status: "ok" }, b])).toBe("read");
  });
  it("includes active nested calls", () => {
    expect(
      activeStepLabel([
        step({
          kind: "other",
          children: [step({ kind: "read", status: "running" })],
        }),
      ])
    ).toBe("read");
  });
});

describe("session steps", () => {
  const notice = step({
    kind: "notice",
    label: "Model fallback",
    detail: { severity: "warning", text: "Using a   smaller model." },
  });
  const compacting = step({
    kind: "compaction",
    label: "compacting context",
    status: "running",
  });

  it("summarizes a notice with its description and unfolds it", () => {
    expect(stepLabel(notice)).toBe("model fallback");
    expect(stepSummary(notice)).toBe("Using a smaller model.");
    expect(hasDetail(notice)).toBe(true);
    expect(hasDetail(step({ kind: "notice", label: "Heads up" }))).toBe(false);
  });

  it("reads a running compaction as the turn's current work", () => {
    expect(runningTurnVerb([compacting])).toBe("compacting context");
  });

  it("does not count notices or compactions as tool calls", () => {
    expect(turnLabelFromSteps([notice])).toBeUndefined();
    expect(turnLabelFromSteps([notice, compacting])).toBe("compacting context");
    expect(
      turnLabelFromSteps([notice, step({ kind: "other", label: "pin" })])
    ).toBe("pin");
  });
});
