// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import { CreateAgentDialog } from "./create-agent-dialog";

vi.mock("@/lib/api", () => ({ api: vi.fn() }));

const types = ["codex", "claude", "opencode"] as const;
const catalog = {
  models: Object.fromEntries(
    types.map((type) => [
      type,
      [
        { id: `${type}-first`, label: `${type} First` },
        { id: `${type}-second`, label: `${type} Second` },
      ],
    ])
  ),
  defaults: Object.fromEntries(types.map((type) => [type, `${type}-second`])),
};

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.resetAllMocks();
});

function mount(type: (typeof types)[number], response: object = catalog) {
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/api/v1/agent-models") return response;
    if (path === "/api/v1/projects") {
      return [{ id: "p1", name: "Sample Project", repoRoot: "/repo" }];
    }
    if (path.startsWith("/api/v1/personas?")) return { personas: [] };
    if (path === "/api/v1/system/engines") return { engines: [] };
    if (path === "/api/v1/system/defaults") return { homeDir: "/repo" };
    if (path.includes("/path-info?"))
      return { exists: true, isDirectory: true, isGitRepo: false };
    return { projects: [] };
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Provider store={createStore()}>
        <MemoryRouter initialEntries={["/agents?project=p1"]}>
          <CreateAgentDialog
            open
            enabledAgentTypes={[...types]}
            initialAgentType={type}
            setOpen={vi.fn()}
            resolveDefaultCwd={() => "/repo"}
            onCreated={vi.fn()}
          />
        </MemoryRouter>
      </Provider>
    </QueryClientProvider>
  );
  return client;
}

it.each(types)(
  "offers Default, unnamed, before %s's model choices",
  async (type) => {
    mount(type);
    const model = await screen.findByRole("combobox", { name: "Model" });
    await within(model).findByText("Default");
    await vi.waitFor(() => expect(model).toHaveProperty("disabled", false));
    fireEvent.keyDown(model, { key: "ArrowDown" });
    const list = screen.getByRole("listbox");
    expect(list.className).toContain(
      "max-h-[clamp(4rem,var(--radix-select-content-available-height),24rem)]"
    );
    const choices = within(list).getAllByRole("option");
    expect(choices.map((choice) => choice.textContent)).toEqual([
      "Default",
      `${type} First`,
      `${type} Second`,
    ]);
    expect(choices[0]?.getAttribute("data-state")).toBe("checked");
  }
);

it.each(types)(
  "keeps %s's project menu out of the layout when closed and usable when open",
  async (type) => {
    mount(type);
    const project = await screen.findByRole("button", {
      name: "Choose project",
    });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(
      project.parentElement?.previousElementSibling?.getAttribute("aria-label")
    ).toBe("Launch location type");
    fireEvent.keyDown(project, { key: "ArrowDown" });
    const menu = screen.getByRole("menu");
    expect(menu.className).toContain(
      "max-h-[clamp(4rem,var(--radix-dropdown-menu-content-available-height),18rem)]"
    );
    expect(
      within(menu).getByRole("menuitem", { name: /Sample Project/ })
    ).toBeDefined();
  }
);

it("replaces the empty fallback when the open dialog receives a learned catalog", async () => {
  const client = mount("opencode", { models: { opencode: [] } });
  const model = await screen.findByRole("combobox", { name: "Model" });
  await within(model).findByText("Default");
  expect(model).toHaveProperty("disabled", true);

  vi.mocked(api).mockResolvedValue(catalog);
  await act(() => client.invalidateQueries({ queryKey: ["agent-models"] }));

  await vi.waitFor(() => expect(model).toHaveProperty("disabled", false));
  await within(model).findByText("Default");
});
