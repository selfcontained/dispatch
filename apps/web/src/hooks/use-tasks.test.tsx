// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTaskActions, useTaskBoard, taskKeys } from "./use-tasks";
const api = vi.fn();
vi.mock("@/lib/api", () => ({ api: (...args: unknown[]) => api(...args) }));
afterEach(() => {
  cleanup();
  api.mockReset();
});
function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {children}
    </QueryClientProvider>
  );
}
describe("task hooks", () => {
  it("loads a project board with a project-scoped key", async () => {
    api.mockResolvedValue({ projectId: "p1", columns: [], tasks: [] });
    const { result } = renderHook(() => useTaskBoard("p1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api).toHaveBeenCalledWith("/api/v1/projects/p1/tasks/board");
    expect(taskKeys.board("p1")).toEqual(["tasks", "p1", "board"]);
  });
  it("sends status changes to the task patch endpoint", async () => {
    api.mockResolvedValue({ id: "t1", columnId: "ready" });
    const { result } = renderHook(() => useTaskActions("p1"), { wrapper });
    await act(async () => {
      await result.current.update.mutateAsync({ id: "t1", columnId: "ready" });
    });
    expect(api).toHaveBeenCalledWith("/api/v1/tasks/t1", {
      method: "PATCH",
      body: JSON.stringify({ columnId: "ready" }),
    });
  });
});

it("sends multipart for task context and JSON for a plain task", async () => {
  api.mockResolvedValue({ id: "tsk_new" });
  const client = new QueryClient();
  const { result } = renderHook(() => useTaskActions("p1"), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  const file = new File(["context"], "context.txt", { type: "text/plain" });
  await act(async () => {
    await result.current.create.mutateAsync({
      projectId: "p1",
      title: "Context",
      startupFiles: [file],
      startupLinks: ["https://example.com/context"],
    });
  });
  const body = api.mock.calls[0]![1]!.body as FormData;
  expect(body).toBeInstanceOf(FormData);
  expect(body.get("title")).toBe("Context");
  expect(body.get("startupFiles")).toBe(file);
  expect(JSON.parse(body.get("startupLinks") as string)).toEqual([
    "https://example.com/context",
  ]);
  await act(async () => {
    await result.current.create.mutateAsync({
      projectId: "p1",
      title: "Plain",
    });
  });
  expect(api.mock.calls[1]![1]!.body).toBe(
    JSON.stringify({ projectId: "p1", title: "Plain" })
  );
});
