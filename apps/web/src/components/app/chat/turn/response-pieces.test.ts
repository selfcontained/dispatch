import { describe, expect, it } from "vitest";
import { responsePieces } from "./response-pieces";
import type { Step } from "./contracts";

const step = (id: string, children?: Step[]): Step => ({
  id,
  kind: "execute",
  label: id,
  status: "running",
  startedAt: 0,
  children,
});

describe("responsePieces", () => {
  it("counts nested commands once and keeps first-seen order as children arrive", () => {
    const initial = responsePieces(null, [step("parent"), step("sibling")], 1);
    const nested = responsePieces(
      initial,
      [step("parent", [step("child", [step("grandchild")])]), step("sibling")],
      1
    );
    expect(nested.map((p) => p.key)).toEqual([
      "step:parent",
      "step:sibling",
      "write:0",
      "step:child",
      "step:grandchild",
    ]);
    const completed = {
      ...step("parent", [step("child", [step("grandchild")])]),
      status: "ok" as const,
    };
    expect(responsePieces(nested, [completed, step("sibling")], 1)).toBe(
      nested
    );
  });
  it("deduplicates IDs even when a child is promoted to the top level", () => {
    const initial = responsePieces(null, [step("parent", [step("child")])], 0);
    expect(responsePieces(initial, [step("parent"), step("child")], 0)).toBe(
      initial
    );
    expect(
      responsePieces(null, [step("child"), step("parent", [step("child")])], 0)
    ).toHaveLength(2);
  });
  it("updates tool metadata without adding another piece or changing arrival order", () => {
    const initial = responsePieces(null, [step("call")], 0);
    const updated = responsePieces(
      initial,
      [{ ...step("call"), label: "mcp__dispatch__post" }],
      0
    );
    expect(updated).toEqual([
      { key: "step:call", category: "dispatch", label: "mcp__dispatch__post" },
    ]);
  });
  it("appends writing chunks once and retains history over shorter snapshots", () => {
    const initial = responsePieces(null, [step("a")], 1);
    const next = responsePieces(initial, [step("a")], 3);
    expect(next.map((p) => p.key)).toEqual([
      "step:a",
      "write:0",
      "write:1",
      "write:2",
    ]);
    expect(responsePieces(next, [], 0)).toBe(next);
  });
});
