// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Agent } from "@/components/app/types";

import { useChatFeedContext } from "./use-chat-feed-context";

vi.mock("@/lib/api", () => ({
  api: vi.fn(async () => ({ agents: [] })),
}));

afterEach(() => {
  cleanup();
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
    ({ agent }: { agent: Agent }) =>
      useChatFeedContext({
        agentId: agent.id,
        agent,
        openLightbox,
        onOpenPath,
      }),
    { wrapper, initialProps: { agent: initial } }
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
});
