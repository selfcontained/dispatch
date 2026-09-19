// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { descendantAgentIds, rootAgentIdOf } from "./use-agent-tree";

const agents = [
  { id: "root", parentAgentId: null },
  { id: "child", parentAgentId: "root" },
  { id: "grandchild", parentAgentId: "child" },
  { id: "other", parentAgentId: null },
  // Its parent is gone from the live list (archived): it is its own root.
  { id: "orphan", parentAgentId: "archived" },
];

describe("rootAgentIdOf", () => {
  it("walks parentAgentId to the top of the lineage", () => {
    expect(rootAgentIdOf("grandchild", agents)).toBe("root");
    expect(rootAgentIdOf("child", agents)).toBe("root");
    expect(rootAgentIdOf("root", agents)).toBe("root");
  });

  it("treats an unknown agent, or one whose parent is unknown, as its own root", () => {
    expect(rootAgentIdOf("orphan", agents)).toBe("orphan");
    expect(rootAgentIdOf("missing", agents)).toBe("missing");
  });

  it("stops on a cycle", () => {
    const loop = [
      { id: "a", parentAgentId: "b" },
      { id: "b", parentAgentId: "a" },
    ];
    expect(["a", "b"]).toContain(rootAgentIdOf("a", loop));
  });
});

describe("descendantAgentIds", () => {
  it("collects every agent under the given one, never itself or a sibling", () => {
    expect([...descendantAgentIds("root", agents)].sort()).toEqual([
      "child",
      "grandchild",
    ]);
    expect([...descendantAgentIds("child", agents)]).toEqual(["grandchild"]);
    expect(descendantAgentIds("grandchild", agents).size).toBe(0);
    expect(descendantAgentIds("other", agents).size).toBe(0);
  });
});
