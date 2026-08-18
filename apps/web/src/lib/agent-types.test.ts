import { describe, expect, it } from "vitest";

import {
  AGENT_TYPES,
  CLI_AGENT_TYPES,
  isAgentType,
  isCliAgentType,
  cardIdForAgent,
  partitionAgentsByLineage,
  sanitizeEnabledAgentTypes,
  sortAgentTypes,
  type AgentType,
} from "./agent-types";

describe("cardIdForAgent", () => {
  const byId = (agents: Array<{ id: string; parentAgentId?: string | null }>) =>
    new Map(agents.map((agent) => [agent.id, agent]));

  it("returns the agent itself when it has no parent", () => {
    const agent = { id: "agt_root" };
    expect(cardIdForAgent(agent, byId([agent]))).toBe("agt_root");
  });

  it("returns the parent for a direct child", () => {
    const parent = { id: "agt_parent" };
    const child = { id: "agt_child", parentAgentId: "agt_parent" };
    expect(cardIdForAgent(child, byId([parent, child]))).toBe("agt_parent");
  });

  it("walks a pre-cap deep tree up to the root card", () => {
    const root = { id: "agt_root" };
    const child = { id: "agt_child", parentAgentId: "agt_root" };
    const grandchild = { id: "agt_grand", parentAgentId: "agt_child" };
    expect(cardIdForAgent(grandchild, byId([root, child, grandchild]))).toBe(
      "agt_root"
    );
  });

  it("stops at the highest ancestor still in the list", () => {
    const child = { id: "agt_child", parentAgentId: "agt_archived" };
    const grandchild = { id: "agt_grand", parentAgentId: "agt_child" };
    expect(cardIdForAgent(grandchild, byId([child, grandchild]))).toBe(
      "agt_child"
    );
  });

  it("terminates on a parent cycle instead of spinning", () => {
    const a = { id: "a", parentAgentId: "b" };
    const b = { id: "b", parentAgentId: "a" };
    expect(["a", "b"]).toContain(cardIdForAgent(a, byId([a, b])));
  });
});

describe("partitionAgentsByLineage", () => {
  it("nests every child, review-role or not", () => {
    const parent = { id: "agt_parent" };
    const reviewChild = { id: "agt_review", parentAgentId: "agt_parent" };
    const plainChild = { id: "agt_plain", parentAgentId: "agt_parent" };
    const independent = { id: "agt_indep", parentAgentId: null };

    const { topLevel, subAgentsByCardId } = partitionAgentsByLineage([
      parent,
      reviewChild,
      plainChild,
      independent,
    ]);

    expect(topLevel).toEqual([parent, independent]);
    expect(subAgentsByCardId.get("agt_parent")).toEqual([
      reviewChild,
      plainChild,
    ]);
  });

  it("flattens a pre-cap grandchild into its root card", () => {
    // A sub agent row cannot host rows of its own, so a grandchild left under
    // its direct parent would render nowhere.
    const root = { id: "agt_root" };
    const child = { id: "agt_child", parentAgentId: "agt_root" };
    const grandchild = { id: "agt_grand", parentAgentId: "agt_child" };

    const { topLevel, subAgentsByCardId } = partitionAgentsByLineage([
      root,
      child,
      grandchild,
    ]);

    expect(topLevel).toEqual([root]);
    expect(subAgentsByCardId.get("agt_root")).toEqual([child, grandchild]);
  });

  it("promotes a child whose parent is gone rather than dropping it", () => {
    const orphan = { id: "agt_orphan", parentAgentId: "agt_archived" };

    const { topLevel, subAgentsByCardId } = partitionAgentsByLineage([orphan]);

    expect(topLevel).toEqual([orphan]);
    expect(subAgentsByCardId.size).toBe(0);
  });

  it("preserves list order within each group", () => {
    const a = { id: "a" };
    const b = { id: "b" };
    const childOfA1 = { id: "c1", parentAgentId: "a" };
    const childOfA2 = { id: "c2", parentAgentId: "a" };

    const { topLevel, subAgentsByCardId } = partitionAgentsByLineage([
      childOfA2,
      a,
      b,
      childOfA1,
    ]);

    expect(topLevel.map((agent) => agent.id)).toEqual(["a", "b"]);
    expect(subAgentsByCardId.get("a")?.map((agent) => agent.id)).toEqual([
      "c2",
      "c1",
    ]);
  });
});

describe("isAgentType", () => {
  it.each([...AGENT_TYPES])("returns true for %s", (type) => {
    expect(isAgentType(type)).toBe(true);
  });

  it("returns false for unknown string", () => {
    expect(isAgentType("vim")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isAgentType("")).toBe(false);
  });
});

describe("isCliAgentType", () => {
  it.each([...CLI_AGENT_TYPES])("returns true for %s", (type) => {
    expect(isCliAgentType(type)).toBe(true);
  });

  it("returns false for terminal", () => {
    expect(isCliAgentType("terminal")).toBe(false);
  });

  it("returns false for unknown string", () => {
    expect(isCliAgentType("vim")).toBe(false);
  });
});

describe("sortAgentTypes", () => {
  it("sorts alphabetically by label with terminal last", () => {
    const input: AgentType[] = [
      "terminal",
      "opencode",
      "claude",
      "codex",
      "cursor",
    ];
    const sorted = sortAgentTypes(input);
    expect(sorted).toEqual([
      "claude",
      "codex",
      "cursor",
      "opencode",
      "terminal",
    ]);
  });

  it("keeps terminal last even when it is the only element", () => {
    expect(sortAgentTypes(["terminal"])).toEqual(["terminal"]);
  });

  it("does not mutate the input array", () => {
    const input: AgentType[] = ["cursor", "claude"];
    const copy = [...input];
    sortAgentTypes(input);
    expect(input).toEqual(copy);
  });

  it("handles an empty array", () => {
    expect(sortAgentTypes([])).toEqual([]);
  });

  it("handles two-element array with terminal first", () => {
    expect(sortAgentTypes(["terminal", "claude"])).toEqual([
      "claude",
      "terminal",
    ]);
  });
});

describe("sanitizeEnabledAgentTypes", () => {
  it("returns all types for non-array input", () => {
    expect(sanitizeEnabledAgentTypes(null)).toEqual([...AGENT_TYPES]);
    expect(sanitizeEnabledAgentTypes(undefined)).toEqual([...AGENT_TYPES]);
    expect(sanitizeEnabledAgentTypes("claude")).toEqual([...AGENT_TYPES]);
    expect(sanitizeEnabledAgentTypes(42)).toEqual([...AGENT_TYPES]);
  });

  it("filters valid agent types from mixed input", () => {
    expect(sanitizeEnabledAgentTypes(["claude", "invalid", "cursor"])).toEqual([
      "claude",
      "cursor",
    ]);
  });

  it("deduplicates entries", () => {
    expect(
      sanitizeEnabledAgentTypes(["claude", "claude", "codex", "codex"])
    ).toEqual(["claude", "codex"]);
  });

  it("returns all types when array is empty", () => {
    expect(sanitizeEnabledAgentTypes([])).toEqual([...AGENT_TYPES]);
  });

  it("returns all types when array has only invalid entries", () => {
    expect(sanitizeEnabledAgentTypes(["vim", 123, null])).toEqual([
      ...AGENT_TYPES,
    ]);
  });

  it("filters out non-string entries", () => {
    expect(sanitizeEnabledAgentTypes([42, true, "claude"])).toEqual(["claude"]);
  });

  it("preserves a single valid type", () => {
    expect(sanitizeEnabledAgentTypes(["terminal"])).toEqual(["terminal"]);
  });
});
