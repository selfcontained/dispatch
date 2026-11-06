// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Agent } from "@/components/app/types";
vi.mock("@/lib/api", () => ({ api: vi.fn() }));
const { api } = await import("@/lib/api");
const { ComposerMeta } = await import("./composer-meta");
afterEach(cleanup);
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};
it("edits engine-reported effort independently of model and follows updated capabilities", async () => {
  const options = [
    {
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "a",
      choices: [{ value: "a", name: "Model A" }],
    },
    {
      id: "reasoning",
      name: "Effort",
      category: "thought_level",
      currentValue: "future",
      choices: [
        { value: "future", name: "Deliberate" },
        { value: "new", name: "Thorough" },
      ],
    },
  ];
  const apiMock = vi.mocked(api);
  apiMock.mockImplementation(async (url, init) => {
    if (url.endsWith("/config")) {
      if (init?.method === "PUT") {
        const body = JSON.parse(init.body as string);
        return {
          running: true,
          options: options.map((o) =>
            o.id === body.configId ? { ...o, currentValue: body.value } : o
          ),
        };
      }
      return { running: true, options };
    }
    if (url.endsWith("/usage"))
      return { context: null, session: null, sessionCost: null, byModel: [] };
    if (url.endsWith("/plans")) return { providers: [] };
    return { models: {} };
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ComposerMeta
        agentId="test"
        agent={{ id: "test", type: "codex" } as Agent}
        active
        liveUsage={null}
        turnKey="idle"
      />
    </QueryClientProvider>
  );
  const effort = await screen.findByTestId("composer-effort-chip");
  expect(effort.textContent).toContain("Deliberate");
  fireEvent.click(screen.getByTestId("composer-model-chip"));
  expect(
    within(screen.getByTestId("composer-model-picker")).queryByText("Effort")
  ).toBeNull();
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  fireEvent.click(effort);
  expect(screen.queryByRole("radio", { name: "Default" })).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: "Thorough" }));
  await waitFor(() => expect(effort.textContent).toContain("Thorough"));
  expect(apiMock).toHaveBeenCalledWith(
    "/api/v1/agents/test/config",
    expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ configId: "reasoning", value: "new" }),
    })
  );
  client.setQueryData(["agent-config", "test"], {
    running: true,
    options: [
      options[0],
      {
        ...options[1],
        currentValue: "changed",
        choices: [
          { value: "changed", name: "Updated" },
          { value: "retry", name: "Retry" },
        ],
      },
    ],
  });
  await waitFor(() => expect(effort.textContent).toContain("Updated"));
  fireEvent.click(effort);
  expect(screen.queryByRole("radio", { name: "Thorough" })).toBeNull();
  expect(screen.getByRole("radio", { name: "Updated" })).toBeTruthy();
  apiMock.mockRejectedValueOnce(new Error("Session stopped"));
  fireEvent.click(screen.getByRole("radio", { name: "Retry" }));
  await screen.findByRole("alert");
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  fireEvent.click(effort);
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});
