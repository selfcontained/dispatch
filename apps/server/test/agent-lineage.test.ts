import { describe, expect, it } from "vitest";

import {
  ancestorChain,
  delegationChain,
  formatDelegationChain,
  relationTo,
} from "../src/agents/lineage.js";

const TREE = [
  { id: "agt_root", name: "orchestrator", parentAgentId: null },
  { id: "agt_planner", name: "planner", parentAgentId: "agt_root" },
  { id: "agt_research", name: "researcher", parentAgentId: "agt_planner" },
  { id: "agt_writer", name: "writer", parentAgentId: "agt_planner" },
  { id: "agt_solo", name: "solo", parentAgentId: null },
];

describe("ancestorChain", () => {
  it("walks from the nearest parent up to the root", () => {
    expect(ancestorChain(TREE, "agt_research").map((a) => a.id)).toEqual([
      "agt_planner",
      "agt_root",
    ]);
  });

  it("is empty for a rootless agent", () => {
    expect(ancestorChain(TREE, "agt_root")).toEqual([]);
  });

  it("is empty for an agent that is not in the set", () => {
    expect(ancestorChain(TREE, "agt_missing")).toEqual([]);
  });

  it("stops at the first ancestor missing from the set", () => {
    const partial = [
      { id: "agt_a", name: "a", parentAgentId: "agt_gone" },
      { id: "agt_root", name: "root", parentAgentId: null },
    ];
    expect(ancestorChain(partial, "agt_a")).toEqual([]);
  });

  it("terminates on a parent cycle instead of looping forever", () => {
    const cyclic = [
      { id: "agt_a", name: "a", parentAgentId: "agt_b" },
      { id: "agt_b", name: "b", parentAgentId: "agt_a" },
    ];
    expect(ancestorChain(cyclic, "agt_a").map((a) => a.id)).toEqual(["agt_b"]);
  });

  it("caps a long chain rather than emitting unbounded output", () => {
    const deep = Array.from({ length: 40 }, (_, i) => ({
      id: `agt_${i}`,
      name: `a${i}`,
      parentAgentId: i === 0 ? null : `agt_${i - 1}`,
    }));
    expect(ancestorChain(deep, "agt_39")).toHaveLength(20);
  });
});

describe("relationTo", () => {
  it.each([
    ["agt_root", "agt_planner", "child"],
    ["agt_planner", "agt_root", "parent"],
    ["agt_root", "agt_research", "descendant"],
    ["agt_research", "agt_root", "ancestor"],
    ["agt_research", "agt_writer", "sibling"],
    ["agt_root", "agt_solo", "unrelated"],
    ["agt_solo", "agt_root", "unrelated"],
  ] as const)("%s -> %s is %s", (viewer, other, expected) => {
    expect(relationTo(TREE, viewer, other)).toBe(expected);
  });

  it("does not treat two rootless agents as siblings", () => {
    expect(relationTo(TREE, "agt_solo", "agt_root")).toBe("unrelated");
  });

  it("returns unrelated when either agent is unknown", () => {
    expect(relationTo(TREE, "agt_root", "agt_missing")).toBe("unrelated");
    expect(relationTo(TREE, "agt_missing", "agt_root")).toBe("unrelated");
  });
});

describe("delegationChain", () => {
  it("stops at the recipient when the recipient is an ancestor", () => {
    expect(
      delegationChain(TREE, "agt_research", "agt_root").map((n) => n.id)
    ).toEqual(["agt_research", "agt_planner", "agt_root"]);
  });

  it("walks to the root when the recipient is not an ancestor", () => {
    expect(
      delegationChain(TREE, "agt_research", "agt_solo").map((n) => n.id)
    ).toEqual(["agt_research", "agt_planner", "agt_root"]);
  });

  it("is just the sender when the sender has no resolvable parent", () => {
    expect(
      delegationChain(TREE, "agt_solo", "agt_root").map((n) => n.id)
    ).toEqual(["agt_solo"]);
  });

  it("marks the recipient in the formatted chain", () => {
    const chain = delegationChain(TREE, "agt_research", "agt_root");
    expect(formatDelegationChain(chain, "agt_root")).toBe(
      "researcher (agt_research) -> planner (agt_planner) -> orchestrator (agt_root, you)"
    );
  });
});
