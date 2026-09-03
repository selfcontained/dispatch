// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatUnreadBadge } from "./chat-unread-badge";

const H = vi.hoisted(() => ({
  enabled: true,
  summary: {
    agents: {} as Record<string, { unread: number; pendingQuestions: number }>,
  },
}));

vi.mock("@/hooks/use-chat-surface-enabled", () => ({
  useChatSurfaceEnabled: () => ({ enabled: H.enabled, loaded: true }),
}));
vi.mock("@/lib/api", () => ({
  api: vi.fn(async () => H.summary),
}));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  H.enabled = true;
  H.summary = { agents: {} };
});

afterEach(() => {
  cleanup();
});

describe("ChatUnreadBadge", () => {
  it("renders nothing while nothing is unread", async () => {
    H.summary = { agents: { agt_1: { unread: 0, pendingQuestions: 0 } } };
    render(<ChatUnreadBadge agentId="agt_1" />, { wrapper });
    await Promise.resolve();
    expect(screen.queryByTestId("agent-chat-unread")).toBeNull();
  });

  it("shows the unread count with the plain accent", async () => {
    H.summary = { agents: { agt_1: { unread: 3, pendingQuestions: 0 } } };
    render(<ChatUnreadBadge agentId="agt_1" />, { wrapper });
    const badge = await screen.findByTestId("agent-chat-unread");
    expect(badge.textContent).toBe("3");
    expect(badge.getAttribute("data-pending-questions")).toBe("0");
    expect(badge.getAttribute("title")).toBe("3 unread chat replies");
    expect(badge.className).not.toContain("status-waiting");
  });

  it("switches to the waiting accent when a question is open", async () => {
    H.summary = { agents: { agt_1: { unread: 1, pendingQuestions: 1 } } };
    render(<ChatUnreadBadge agentId="agt_1" />, { wrapper });
    const badge = await screen.findByTestId("agent-chat-unread");
    expect(badge.className).toContain("status-waiting");
    expect(badge.getAttribute("title")).toBe(
      "1 unread chat reply · 1 open question"
    );
  });

  it("stays hidden with the chat surface off, even with unread data", async () => {
    H.enabled = false;
    H.summary = { agents: { agt_1: { unread: 5, pendingQuestions: 2 } } };
    render(<ChatUnreadBadge agentId="agt_1" />, { wrapper });
    await Promise.resolve();
    expect(screen.queryByTestId("agent-chat-unread")).toBeNull();
  });
});
