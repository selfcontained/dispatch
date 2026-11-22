// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { api } from "@/lib/api";

import { AgentName } from "./agent-name";

vi.mock("@/lib/api", () => ({ api: vi.fn() }));
afterEach(cleanup);

function renderName(identity: () => Promise<unknown>) {
  vi.mocked(api).mockImplementation(((path: string) =>
    path === "/api/v1/agents"
      ? Promise.resolve({ agents: [] })
      : identity()) as typeof api);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AgentName agentId="agt_123" />
    </QueryClientProvider>
  );
}

it("names an archived agent without flashing its id", async () => {
  const view = renderName(async () => ({
    agent: { id: "agt_123", name: "Archived builder", archived: true },
  }));
  expect(view.container.textContent).toBe("…");
  expect(await screen.findByText("Archived builder")).toBeTruthy();
});

it("falls back to the id when there is no name", async () => {
  renderName(async () => {
    throw new Error("Agent not found.");
  });
  expect(await screen.findByText("agt_123")).toBeTruthy();
});
