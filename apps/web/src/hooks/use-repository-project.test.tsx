// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { api, ApiError } from "@/lib/api";
import { useRepositoryProject } from "./use-repository-project";

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  api: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("reuses the project created concurrently after a unique-constraint conflict", async () => {
  let conflicted = false;
  const project = { id: "winner", name: "Repo" };
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (init?.method === "POST") {
      conflicted = true;
      throw new ApiError(409, "This repository already has a project.");
    }
    if (path.startsWith("/api/v1/projects?repository="))
      return conflicted ? [project] : [];
    if (path === "/api/v1/projects/winner/repository")
      return { url: "https://github.com/org/repo" };
    throw new Error(path);
  });
  const client = new QueryClient();
  const { result } = renderHook(useRepositoryProject, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  await act(async () => {
    expect(
      await result.current.mutateAsync({
        repository: "https://github.com/org/repo.git/",
        name: "Repo",
        color: "#9575ed",
      })
    ).toEqual(project);
  });
  client.clear();
});
