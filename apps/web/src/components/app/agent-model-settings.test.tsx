// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { useAgentModelCatalog } from "@/hooks/use-agent-model-catalog";
import { AgentModelSettings } from "./agent-model-settings";

const api = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api }));

let saveError: Error | null;
let disabled: string[];

beforeEach(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  saveError = null;
  disabled = ["sol"];
  api.mockImplementation(async (path: string, init?: { body: string }) => {
    if (init) {
      if (saveError) throw saveError;
      const change = JSON.parse(init.body) as { model?: string };
      if (change.model) disabled = [...disabled, change.model];
      return {};
    }
    return {
      models: {
        codex: ["sol", "astra", "luna"].map((id) => ({ id, label: id })),
      },
      defaults: { codex: "sol" },
      availability: {
        codex: { autoEnable: true, disabled, unseen: ["luna"] },
      },
    };
  });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

it("filters what can be chosen and keeps saved values", async () => {
  const { result } = renderHook(() => useAgentModelCatalog("codex"), {
    wrapper: wrapper(),
  });
  await waitFor(() => expect(result.current.loaded).toBe(true));
  expect(result.current.options.map((o) => o.id)).toEqual(["astra", "luna"]);
  expect(result.current.normalizeModel("sol")).toBe("sol");
  expect(result.current.savedOption("sol")?.label).toBe("sol");
  // The engine's default is off, so the picker falls back to its own setting.
  expect(result.current.defaultModel).toBeNull();
});

it("saves an uncheck without asking, and locks the last one on", async () => {
  render(<AgentModelSettings agentType="codex" />, { wrapper: wrapper() });
  fireEvent.click(await screen.findByRole("checkbox", { name: /astra/ }));
  await screen.findByText("At least one model must stay on.");
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith("/api/v1/app/settings/agent-models", {
      method: "PATCH",
      body: JSON.stringify({
        agentType: "codex",
        model: "astra",
        enabled: false,
      }),
    })
  );
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("shows a failed save and puts the checkbox back", async () => {
  saveError = new Error("Save failed");
  render(<AgentModelSettings agentType="codex" />, { wrapper: wrapper() });
  const astra = await screen.findByRole("checkbox", { name: /astra/ });
  fireEvent.click(astra);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Save failed"
  );
  await waitFor(() => expect(astra.getAttribute("aria-checked")).toBe("true"));
});

it("locks the last model on from what is shown, while earlier saves wait", async () => {
  disabled = [];
  render(<AgentModelSettings agentType="codex" />, { wrapper: wrapper() });
  const box = (name: RegExp) => screen.getByRole("checkbox", { name });
  await screen.findByRole("checkbox", { name: /astra/ });
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  api.mockImplementationOnce(async () => {
    await held;
    return {};
  });
  // The first save holds the queue, so the second hasn't reached the cache.
  fireEvent.click(box(/sol/));
  fireEvent.click(box(/astra/));
  await waitFor(() => expect(box(/luna/).hasAttribute("disabled")).toBe(true));
  release();
});
