// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Agent } from "@/components/app/types";

import { agentDisplayName } from "./chat-entries";
import { useChatFeedContext } from "./use-chat-feed-context";

const listed = vi.hoisted(() => ({ agents: [] as unknown[] }));
vi.mock("@/lib/api", () => ({
  api: vi.fn(async () => ({ agents: listed.agents })),
}));

afterEach(() => {
  cleanup();
  listed.agents = [];
});

function agentRecord(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agt_1",
    name: "builder",
    type: "claude",
    status: "running",
    cwd: "/repo",
    ...overrides,
  } as Agent;
}

function setup(initial: Agent) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const openLightbox = vi.fn();
  const onOpenPath = vi.fn();
  const hook = renderHook(
    ({
      agent,
      agentNames,
    }: {
      agent: Agent;
      agentNames?: Record<string, string>;
    }) =>
      useChatFeedContext({
        agentId: agent.id,
        agent,
        openLightbox,
        onOpenPath,
        agentNames,
      }),
    {
      wrapper,
      initialProps: { agent: initial } as {
        agent: Agent;
        agentNames?: Record<string, string>;
      },
    }
  );
  return { ...hook, client, onOpenPath };
}

describe("useChatFeedContext", () => {
  it("keeps ctx across an upsert that changed nothing the rows show", () => {
    const { result, rerender } = setup(agentRecord());
    const { ctx } = result.current;
    // A fresh record with equal content, as every agent.upsert delivers;
    // a status change is not something the rows show either.
    rerender({ agent: agentRecord() });
    expect(result.current.ctx).toBe(ctx);
    rerender({ agent: agentRecord({ status: "stopped" }) });
    expect(result.current.ctx).toBe(ctx);
  });

  it("gives ctx a new identity only when what the rows show changes", () => {
    const { result, rerender, onOpenPath } = setup(agentRecord());
    const { ctx } = result.current;
    rerender({ agent: agentRecord({ name: "renamed" }) });
    expect(result.current.ctx).not.toBe(ctx);
    expect(result.current.ctx.agentName).toBe("renamed");
    expect(result.current.ctx.onOpenPath).toBe(onOpenPath);
  });

  it("names an agent from the page's names when the directory has no row for it", () => {
    const { result, rerender } = setup(agentRecord());
    rerender({ agent: agentRecord(), agentNames: { agt_gone: "helper" } });
    const { ctx } = result.current;
    expect(agentDisplayName("agt_gone", ctx)).toBe("helper");
    // Equal names in a fresh object, as every page refetch hands back,
    // keep the context's identity: every row is memoised on it.
    rerender({ agent: agentRecord(), agentNames: { agt_gone: "helper" } });
    expect(result.current.ctx).toBe(ctx);
  });

  it("keeps the name of a peer archived while the feed is open", async () => {
    listed.agents = [
      agentRecord(),
      agentRecord({ id: "agt_child", name: "helper", parentAgentId: "agt_1" }),
    ];
    const { result, client } = setup(agentRecord());
    await waitFor(() =>
      expect(agentDisplayName("agt_child", result.current.ctx)).toBe("helper")
    );
    // Archived: the agents list drops it before any page is fetched again.
    listed.agents = [agentRecord()];
    await act(() => client.refetchQueries({ queryKey: ["agents"] }));
    await waitFor(() =>
      expect(result.current.ctx.peers?.agt_child).toBeUndefined()
    );
    expect(agentDisplayName("agt_child", result.current.ctx)).toBe("helper");
  });
});
