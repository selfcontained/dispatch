// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
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

function mount(
  type: (typeof types)[number],
  response: object = catalog,
  withRunner = false
) {
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/api/v1/agent-models") return response;
    if (path === "/api/v1/projects") {
      return [
        { id: "p1", name: "Sample Project", repoRoot: "/repo" },
        { id: "p2", name: "Folder Only", repoRoot: "/folder" },
      ];
    }
    if (path === "/api/runners")
      return {
        runners: withRunner
          ? [
              {
                id: "runner-a",
                name: "Runner A",
                status: "online",
                workspaces: ["@session"],
                managedWorkspace: true,
              },
            ]
          : [],
      };
    if (path === "/api/v1/projects/p1/repository")
      return { url: "https://github.com/example/project.git" };
    if (path === "/api/v1/projects/p2/repository") return { url: null };
    if (path.startsWith("/api/v1/git/branches?"))
      return { branches: ["trunk", "release"], defaultBranch: "trunk" };
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

it.each(types)("shows %s's stored default and model choices", async (type) => {
  mount(type);
  const model = await screen.findByRole("combobox", { name: "Model" });
  await within(model).findByText(`${type} Second`);
  fireEvent.keyDown(model, { key: "ArrowDown" });
  const list = screen.getByRole("listbox");
  expect(list.className).toContain(
    "max-h-[clamp(4rem,var(--radix-select-content-available-height),24rem)]"
  );
  const choices = within(list).getAllByRole("option");
  expect(choices.map((choice) => choice.textContent)).toEqual([
    `${type} First`,
    `${type} Second`,
  ]);
  expect(choices[1]?.getAttribute("data-state")).toBe("checked");
});

it.each(types)(
  "keeps %s's project menu out of the layout when closed and usable when open",
  async (type) => {
    mount(type);
    const project = await screen.findByRole("combobox", {
      name: "Choose project",
    });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(
      project.parentElement?.previousElementSibling?.getAttribute("aria-label")
    ).toBe("Launch location type");
    fireEvent.keyDown(project, { key: "ArrowDown" });
    const menu = screen.getByRole("listbox");
    expect(menu.className).toContain(
      "max-h-[clamp(4rem,var(--radix-select-content-available-height),18rem)]"
    );
    expect(
      within(menu).getByRole("option", { name: /Sample Project/ })
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

  await within(model).findByText("opencode Second");
  expect(model).toHaveProperty("disabled", false);
});

it("requires a runner project and loads branches from its repository", async () => {
  mount("codex", catalog, true);
  const machine = await screen.findByRole("combobox", { name: "Runs on" });
  fireEvent.keyDown(machine, { key: "ArrowDown" });
  fireEvent.click(screen.getByRole("option", { name: /Runner A/ }));

  const project = screen.getByRole("combobox", { name: "Project" });
  const submit = screen.getByRole("button", { name: "Create agent" });
  expect(project.getAttribute("aria-required")).toBe("true");
  expect(submit).toHaveProperty("disabled", true);
  expect(screen.queryByTestId("project-location")).toBeNull();
  expect(screen.queryByTestId("create-agent-cwd")).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Workspace" })).toBeNull();

  await waitFor(() => expect(project).toHaveProperty("disabled", false));
  fireEvent.keyDown(project, { key: "ArrowDown" });
  const menu = screen.getByRole("listbox");
  expect(
    within(menu).queryByRole("option", { name: "Folder Only" })
  ).toBeNull();
  fireEvent.click(within(menu).getByRole("option", { name: "Sample Project" }));

  const startingBranch = await screen.findByRole("combobox", {
    name: "Starting branch",
  });
  await within(startingBranch).findByText("trunk");
  expect(api).toHaveBeenCalledWith(
    "/api/v1/git/branches?runnerId=runner-a&repository=https%3A%2F%2Fgithub.com%2Fexample%2Fproject.git",
    expect.objectContaining({ signal: expect.any(AbortSignal) })
  );
  expect(submit).toHaveProperty("disabled", false);
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Toggle new branch creation" })
  );
  expect(
    screen.getByRole("combobox", { name: "Existing branch" })
  ).toBeDefined();
});
