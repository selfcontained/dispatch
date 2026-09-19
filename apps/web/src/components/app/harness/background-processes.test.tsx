// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BackgroundProcesses } from "./background-processes";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: apiMock }));
afterEach(cleanup);
beforeEach(() => {
  apiMock.mockReset();
});

it("collapses running processes, opens output, and stops the selected process", async () => {
  const record = {
    id: "process-1",
    agentId: "agent-a",
    title: "Type checking",
    command: "pnpm run check",
    cwd: "/tmp",
    status: "running",
    startedAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null,
    output: "Checking types",
    truncated: false,
  };
  apiMock.mockImplementation(
    async (url: string, options?: { method?: string }) => {
      if (options?.method === "POST") {
        record.status = "stopped";
        return undefined;
      }
      return url.endsWith("process-1")
        ? { ...record }
        : { processes: [{ ...record }] };
    }
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <BackgroundProcesses agentId="agent-a" />
    </QueryClientProvider>
  );
  await screen.findByText("1 running");
  expect(screen.queryByText("Type checking")).toBeNull();
  fireEvent.click(screen.getByTestId("background-processes-toggle"));
  fireEvent.click(screen.getByText("Type checking"));
  await screen.findByText("Checking types");
  fireEvent.click(screen.getByRole("button", { name: "Stop process" }));
  await waitFor(() =>
    expect(apiMock).toHaveBeenCalledWith(
      "/api/v1/agents/agent-a/harness/processes/process-1/stop",
      { method: "POST" }
    )
  );
  await screen.findByText("1 finished");
});

it("shows four compact rows with running work first, then expands and collapses history", async () => {
  const records = Array.from({ length: 7 }, (_, index) => ({
    id: `process-${index}`,
    title: `Check ${index}`,
    status: index === 6 ? "running" : "completed",
    startedAt: new Date().toISOString(),
    endedAt: null,
  }));
  apiMock.mockResolvedValue({ processes: records });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <BackgroundProcesses agentId="agent-a" />
    </QueryClientProvider>
  );
  await screen.findByText("1 running");
  const toggle = screen.getByTestId("background-processes-toggle");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  const rows = screen.getAllByTestId("background-process-row");
  expect(rows).toHaveLength(4);
  expect(rows[0].textContent).toContain("Check 6");
  expect(rows[0].querySelector(".lucide-chevron-right")).toBeNull();
  expect(toggle.querySelector(".lucide-terminal")).toBeNull();
  expect(toggle.querySelectorAll(".lucide-chevron-down")).toHaveLength(1);
  const more = screen.getByRole("button", { name: "+3 more" });
  fireEvent.click(more);
  expect(screen.getAllByTestId("background-process-row")).toHaveLength(7);
  fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
  expect(screen.getAllByTestId("background-process-row")).toHaveLength(4);
  fireEvent.click(toggle);
  expect(screen.queryAllByTestId("background-process-row")).toHaveLength(0);
});

it("keeps refresh errors and retry available while collapsed", async () => {
  apiMock.mockRejectedValueOnce(new Error("offline"));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <BackgroundProcesses agentId="agent-a" />
    </QueryClientProvider>
  );
  await screen.findByRole("alert");
  expect(
    screen
      .getByTestId("background-processes-toggle")
      .getAttribute("aria-expanded")
  ).toBe("false");
  apiMock.mockResolvedValue({ processes: [] });
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(screen.queryByTestId("background-processes")).toBeNull()
  );
});
