// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ActivityPane } from "./activity-pane";

type Query = {
  data?: unknown;
  error: Error | null;
  isError: boolean;
  isPending: boolean;
  isFetching: boolean;
  refetch: ReturnType<typeof vi.fn>;
};
const H = vi.hoisted(() => ({ queries: {} as Record<string, unknown> }));

vi.mock("@/hooks/use-activity", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTokenStats: () => H.queries.stats,
  useTokenDaily: () => H.queries.daily,
  useTokenByModel: () => H.queries.model,
  useTokenByProject: () => H.queries.project,
}));
vi.mock("./decision-metrics", () => ({ DecisionMetricsSection: () => null }));
vi.mock("@/components/app/agent-history-tab", () => ({
  AgentHistoryTab: () => null,
}));

const succeeded = (data: unknown): Query => ({
  data,
  error: null,
  isError: false,
  isPending: false,
  isFetching: false,
  refetch: vi.fn(),
});

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  H.queries = {
    stats: succeeded({
      total_input: 0,
      total_cache_creation: 0,
      total_cache_read: 0,
      total_output: 0,
      total_messages: 0,
      total_sessions: 0,
    }),
    daily: succeeded({ days: [], granularity: "day" }),
    model: succeeded([]),
    project: succeeded([]),
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("shows the empty copy once every request succeeded with nothing", () => {
  render(<ActivityPane open />);
  expect(screen.getByText("No token usage yet.")).toBeTruthy();
});

it("shows loading, not empty, while a request is pending", () => {
  H.queries.stats = { ...succeeded(undefined), isPending: true };
  render(<ActivityPane open />);
  expect(screen.getByText("Loading token usage…")).toBeTruthy();
  expect(screen.queryByText("No token usage yet.")).toBeNull();
});

it("shows an error, not empty, and retries only what failed", () => {
  const failed = {
    ...succeeded(undefined),
    error: new Error("boom"),
    isError: true,
  };
  const { daily } = H.queries;
  H.queries.stats = failed;
  render(<ActivityPane open />);
  expect(screen.getByRole("alert").textContent).toContain(
    "Couldn't load token usage: boom"
  );
  expect(screen.queryByText("No token usage yet.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(failed.refetch).toHaveBeenCalledOnce();
  expect((daily as Query).refetch).not.toHaveBeenCalled();
});
