// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { AgentHistoryTab } from "./agent-history-tab";

const fixtures = vi.hoisted(() => ({
  agents: [] as Record<string, unknown>[],
}));

vi.mock("@/hooks/use-agent-history", () => ({
  useHistoryProjects: () => ({
    data: ["/work/alpha", "/work/gamma", "/work/beta"],
  }),
  useHistoryAgents: () => ({
    data: { agents: fixtures.agents, total: fixtures.agents.length },
    isSuccess: true,
  }),
}));
vi.mock("./agent-session-link", () => ({
  AgentSessionLink: ({ children }: { children: import("react").ReactNode }) => (
    <span>{children}</span>
  ),
}));
vi.mock("./agent-history-detail", () => ({ AgentHistoryDetail: () => null }));

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);
it("pins main's project picker labels and order for local folders", async () => {
  render(
    <MemoryRouter>
      <AgentHistoryTab range="all" onRangeChange={() => {}} />
    </MemoryRouter>
  );
  const trigger = screen.getByText("All projects");
  fireEvent.click(trigger);
  const options = await screen.findAllByRole("option");
  expect(options.map((o) => o.textContent)).toEqual([
    "All projects",
    "/work/alpha",
    "/work/gamma",
    "/work/beta",
  ]);
});

it("renders a supplied project key with the existing folder label formatter", () => {
  fixtures.agents = [
    {
      id: "fixture",
      name: "Session",
      type: "codex",
      status: "done",
      cwd: "runner://fixture/@session",
      project: "https://example.com/demo/alpha",
      totalTokens: 0,
      groupTotalTokens: 0,
      children: [],
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      durationMs: 0,
    },
  ];
  render(
    <MemoryRouter>
      <AgentHistoryTab range="all" onRangeChange={() => {}} />
    </MemoryRouter>
  );
  expect(screen.getByText("demo/alpha")).toBeTruthy();
  expect(screen.queryByText("fixture/@session")).toBeNull();
  fixtures.agents = [];
});
