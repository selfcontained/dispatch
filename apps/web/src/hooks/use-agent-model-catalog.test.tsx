// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";

import { useAgentModelCatalog } from "./use-agent-model-catalog";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: apiMock }));
afterEach(cleanup);

it("hides Gemini from Dispatch launch forms without changing the cached catalog", async () => {
  const dispatch = [
    { id: "claude/default", label: "Claude Code", group: "Claude Code" },
    { id: "gemini/default", label: "Gemini CLI", group: "Gemini CLI" },
    { id: "gemini/custom", label: "Gemini custom", group: "Gemini CLI" },
    { id: "codex/default", label: "Codex", group: "Codex" },
    { id: "opencode/default", label: "OpenCode", group: "OpenCode" },
  ];
  const models = { dispatch, claude: [{ id: "opus", label: "Opus" }] };
  apiMock.mockResolvedValue({ models });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const { result } = renderHook(
    () => ({
      dispatch: useAgentModelCatalog("dispatch"),
      claude: useAgentModelCatalog("claude"),
    }),
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    }
  );
  await waitFor(() => expect(result.current.dispatch.loaded).toBe(true));
  expect(result.current.dispatch.options.map((option) => option.id)).toEqual([
    "claude/default",
    "codex/default",
    "opencode/default",
  ]);
  expect(result.current.dispatch.normalizeModel("gemini/default")).toBeNull();
  expect(result.current.dispatch.normalizeModel("codex/default")).toBe(
    "codex/default"
  );
  expect(result.current.claude.options).toEqual(models.claude);
  expect(client.getQueryData(["agent-models"])).toEqual({ models });
});
