// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { AgentHistoryTab } from "./agent-history-tab";

vi.mock("@/hooks/use-agent-history", () => ({
  useHistoryProjects: () => ({
    data: ["/work/alpha", "/work/gamma", "/work/beta"],
  }),
  useHistoryAgents: () => ({ data: { agents: [], total: 0 }, isSuccess: true }),
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
