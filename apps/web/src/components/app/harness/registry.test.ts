import { describe, expect, it } from "vitest";

import type { Step } from "./contracts";
import {
  argsSummary,
  hasDetail,
  stepLabel,
  stepSummary,
  toolName,
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
});

describe("unwrapReadOutput", () => {
  it("strips dsh's path/type/content wrapper", () => {
    const wrapped =
      "<path>/r/README.md</path>\n<type>file</type>\n<content>\n1: # Dispatch\n2: hi\n</content>";
    expect(unwrapReadOutput(wrapped)).toBe("1: # Dispatch\n2: hi\n");
    expect(unwrapReadOutput("plain")).toBe("plain");
  });
});
