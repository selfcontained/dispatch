// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { BackgroundProcesses } from "./background-processes";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: apiMock }));
afterEach(cleanup);

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
  expect(screen.getByText("Type checking").closest("[hidden]")).not.toBeNull();
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
