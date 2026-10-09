// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "@/lib/api";
vi.mock("@/lib/api", () => ({ api: vi.fn() }));

import {
  descendantAgentIds,
  rootAgentIdOf,
  useAgentRecord,
  useAgentSeats,
} from "./use-agent-tree";

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

describe("useAgentRecord", () => {
  it("shares fresh by-id queries across mounts and refetches an aged archived record", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(["agents"], []);
    const identity = {
      id: "archived",
      name: "Archived reviewer",
      type: "claude",
      model: "opus",
      persona: "reviewer",
      parentAgentId: "root",
      createdAt: "2026-01-01",
      seat: 2,
      rootId: "root",
    };
    vi.mocked(api).mockResolvedValue({ agent: identity });
    const wrapper = ({ children }: { children: import("react").ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    const first = renderHook(
      () => {
        const seats = useAgentSeats(["archived"]);
        return [useAgentRecord("archived"), useAgentRecord("archived"), seats];
      },
      { wrapper }
    );
    await waitFor(() =>
      expect(first.result.current).toEqual([
        identity,
        identity,
        { archived: 2 },
      ])
    );
    first.unmount();
    const next = renderHook(() => useAgentRecord("archived"), { wrapper });
    expect(next.result.current).toEqual(identity);
    expect(
      vi
        .mocked(api)
        .mock.calls.filter(
          ([url]) => url === "/api/v1/agents/archived/identity"
        )
    ).toHaveLength(1);
    next.unmount();
    client.setQueryData(["agent-identity", "archived"], identity, {
      updatedAt: Date.now() - 6 * 60 * 1000,
    });
    const aged = renderHook(() => useAgentRecord("archived"), { wrapper });
    await waitFor(() =>
      expect(
        vi
          .mocked(api)
          .mock.calls.filter(
            ([url]) => url === "/api/v1/agents/archived/identity"
          )
      ).toHaveLength(2)
    );
    expect(aged.result.current).toEqual(identity);
    cleanup();
    client.clear();
  });
});
