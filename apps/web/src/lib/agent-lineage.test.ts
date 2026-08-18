import { describe, expect, it } from "vitest";

import { cardIdForAgent, partitionAgentsByLineage } from "./agent-lineage";

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

  it("elects one representative for a parent cycle so a card still exists", () => {
    // Stopping the walk without electing a representative would give each
    // member a different answer, leaving the cycle with no card at all.
    const a = { id: "a", parentAgentId: "b" };
    const b = { id: "b", parentAgentId: "a" };
    const index = byId([a, b]);
    expect(cardIdForAgent(a, index)).toBe("a");
    expect(cardIdForAgent(b, index)).toBe("a");
  });

  it("agrees with the cycle's own members when walking into one", () => {
    // "0" sorts below the cycle members, so electing over the whole walk
    // rather than the cycle slice would pick the approaching agent instead.
    const outside = { id: "0", parentAgentId: "a" };
    const a = { id: "a", parentAgentId: "b" };
    const b = { id: "b", parentAgentId: "a" };
    const index = byId([outside, a, b]);
    expect(cardIdForAgent(outside, index)).toBe("a");
    expect(cardIdForAgent(a, index)).toBe("a");
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

  it("keeps a cycle's members on screen under one card", () => {
    const a = { id: "a", parentAgentId: "b" };
    const b = { id: "b", parentAgentId: "a" };

    const { topLevel, subAgentsByCardId } = partitionAgentsByLineage([a, b]);

    expect(topLevel).toEqual([a]);
    expect(subAgentsByCardId.get("a")).toEqual([b]);
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
