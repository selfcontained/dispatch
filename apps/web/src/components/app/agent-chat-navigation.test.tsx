// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { AgentChatNavigation } from "./agent-chat-navigation";
import { api } from "@/lib/api";

vi.mock("@/lib/api", () => ({ api: vi.fn() }));
vi.mock("@/hooks/use-agent-tree", () => ({
  useAgentRecord: (id: string | null) =>
    id ? { id, name: id, archived: id === "archived-parent" } : null,
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
function Location() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname}
      {location.search}
    </output>
  );
}
function mount(url: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <AgentChatNavigation agentId="child" parentId="parent" />
        <Location />
      </MemoryRouter>
    </QueryClientProvider>
  );
}
it("looks up the immutable launch independent of parent feed pagination", async () => {
  vi.mocked(api).mockResolvedValue({
    streamId: "archived-parent",
    threadId: "older-discussion",
    blockId: "launch",
  });
  mount("/agents/child");
  const link = await screen.findByRole("link", {
    name: "Earlier launch history",
  });
  expect(link.getAttribute("href")).toBe(
    "/activity/history/archived-parent?thread=launch&returnAgent=child"
  );
  expect(api).toHaveBeenCalledWith("/api/v1/agents/child/chat-location");
});
it("repairs a legacy child URL into its archived actual container and preserves anchors", async () => {
  vi.mocked(api).mockResolvedValue({
    streamId: "archived-parent",
    threadId: "launch",
    blockId: "finding",
  });
  mount("/agents/child?thread=launch&finding=finding&block=message");
  await waitFor(() =>
    expect(screen.getByTestId("location").textContent).toBe(
      "/activity/history/archived-parent?thread=launch&finding=finding&block=message&returnAgent=child"
    )
  );
  expect(api).toHaveBeenCalledWith(
    "/api/v1/agents/child/chat-location?blockId=finding"
  );
});
it("opens a legacy block-only URL in its stored discussion", async () => {
  vi.mocked(api).mockResolvedValue({
    streamId: "parent",
    threadId: "launch",
    blockId: "message",
  });
  mount("/agents/child?block=message");
  await waitFor(() =>
    expect(screen.getByTestId("location").textContent).toBe(
      "/agents/parent?block=message&returnAgent=child&thread=launch"
    )
  );
});
it("keeps unavailable legacy locations at home without inventing a launch link", async () => {
  vi.mocked(api).mockResolvedValue(null);
  mount("/agents/child?block=missing");
  await waitFor(() => expect(api).toHaveBeenCalled());
  expect(
    screen.queryByRole("link", { name: "Earlier launch history" })
  ).toBeNull();
  expect(screen.getByTestId("location").textContent).toBe(
    "/agents/child?block=missing"
  );
});
