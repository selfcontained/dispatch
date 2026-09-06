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
    pins: [{ id: "p1", label: "PR", value: "#1", type: "string" }],
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
  const onOpenReview = vi.fn();
  const hook = renderHook(
    ({ agent }: { agent: Agent }) =>
      useChatFeedContext({
        agentId: agent.id,
        agent,
        openLightbox,
        onOpenReview,
      }),
    { wrapper, initialProps: { agent: initial } }
  );
  return { ...hook, client };
}

describe("useChatFeedContext", () => {
  it("keeps ctx and the pin state across an upsert that changed nothing", () => {
    const { result, rerender } = setup(agentRecord());
    const { ctx, pinShortcuts } = result.current;
    // A fresh record with equal content, as every agent.upsert delivers.
    rerender({ agent: agentRecord({ pins: [...agentRecord().pins!] }) });
    expect(result.current.ctx).toBe(ctx);
    expect(result.current.pinShortcuts).toBe(pinShortcuts);
  });

  it("moves only the pin state when a pin, or the agent's status, changes", () => {
    const { result, rerender } = setup(agentRecord());
    const { ctx, pinShortcuts } = result.current;

    rerender({
      agent: agentRecord({
        pins: [{ id: "p1", label: "PR", value: "#2", type: "string" }],
      }),
    });
    expect(result.current.ctx).toBe(ctx);
    expect(result.current.pinShortcuts).not.toBe(pinShortcuts);
    expect(result.current.pinShortcuts.pins[0]?.value).toBe("#2");

    const afterPin = result.current.pinShortcuts;
    rerender({
      agent: agentRecord({
        status: "stopped",
        pins: [{ id: "p1", label: "PR", value: "#2", type: "string" }],
      }),
    });
    expect(result.current.ctx).toBe(ctx);
    expect(result.current.pinShortcuts).not.toBe(afterPin);
    expect(result.current.pinShortcuts.agentIsRunning).toBe(false);
  });

  it("gives ctx a new identity only when what the rows show changes", () => {
    const { result, rerender } = setup(agentRecord());
    const { ctx } = result.current;
    rerender({ agent: agentRecord({ name: "renamed" }) });
    expect(result.current.ctx).not.toBe(ctx);
    expect(result.current.ctx.agentName).toBe("renamed");
    expect(result.current.ctx).not.toHaveProperty("pins");
  });
});
