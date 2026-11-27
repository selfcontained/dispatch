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
import { RunnerRepositoryPicker } from "./runner-repository-picker";
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
  withRunner = false,
  initialEntry = "/agents?project=p1"
) {
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/api/v1/agent-models") return response;
    if (path === "/api/v1/launch-targets")
      return {
        targets: [
          {
            key: "controller-choice",
            name: "This computer",
            status: "online",
            location: { kind: "folder" },
            dataUrl: "/fixture/controller",
            branchesUrl: "/fixture/controller/branches",
            defaultBaseBranch: "main",
            launchFields: {},
            selectionFields: { runner: "controller" },
          },
          ...(withRunner
            ? [
                {
                  key: "runner-choice",
                  name: "Runner A",
                  status: "online",
                  location: {
                    kind: "project",
                    repositorySearchUrl:
                      "/api/v1/runners/runner-a/repository-search",
                    projects: [
                      {
                        id: "p1",
                        name: "Sample Project",
                        repoRoot: "/repo",
                        repository: "https://github.com/example/project.git",
                      },
                    ],
                  },
                  dataUrl: "/fixture/runner",
                  branchesUrl: "/fixture/runner/branches",
                  defaultBaseBranch: "",
                  launchFields: { runner: "runner-a" },
                  selectionFields: { runner: "runner-a" },
                },
              ]
            : []),
        ],
      };
    if (path.startsWith("/fixture/") && path.includes("/branches?"))
      return { branches: ["trunk", "release"], defaultBranch: "trunk" };
    if (path.startsWith("/fixture/")) {
      const target = new URL(path, "http://fixture");
      return {
        catalog: response,
        agentTypes: [...types],
        engineOptions: [],
        directory: target.pathname === "/fixture/controller" ? "/repo" : "",
        personasUrl: "/api/v1/personas?fixture=1",
        branchesUrl: `${target.pathname}/branches?projectId=p1`,
        defaults: {
          preferenceKey: target.pathname,
          baseBranch: target.pathname === "/fixture/controller" ? "main" : "",
          launchFields:
            target.pathname === "/fixture/controller"
              ? {}
              : { runner: "runner-a" },
        },
      };
    }
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
        <MemoryRouter initialEntries={[initialEntry]}>
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
  return {
    client,
    setCatalog: (next: object) => {
      response = next;
    },
  };
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
  const { client, setCatalog } = mount("opencode", {
    models: { opencode: [] },
  });
  const model = await screen.findByRole("combobox", { name: "Model" });
  await within(model).findByText("Default");
  expect(model).toHaveProperty("disabled", true);

  setCatalog(catalog);
  await act(() => client.invalidateQueries({ queryKey: ["agent-models"] }));

  await within(model).findByText("opencode Second");
  expect(model).toHaveProperty("disabled", false);
});

it("requires a runner project and loads branches from its repository", async () => {
  mount("codex", catalog, true, "/agents");
  const originalApi = vi.mocked(api).getMockImplementation()!;
  let finishBranches:
    | ((value: { branches: string[]; defaultBranch: string }) => void)
    | undefined;
  vi.mocked(api).mockImplementation((path, init) =>
    path.startsWith("/fixture/runner/branches?")
      ? new Promise((resolve) => {
          finishBranches = resolve;
        })
      : originalApi(path, init)
  );
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

  const startingBefore = screen.getByRole("combobox", {
    name: "Starting branch",
  });
  const newBranchBefore = screen.getByRole("checkbox", {
    name: "Toggle new branch creation",
  });
  const nameBefore = screen.getByRole("textbox", { name: "New branch name" });
  expect(startingBefore).toHaveProperty("disabled", true);
  expect(newBranchBefore).toHaveProperty("disabled", true);
  expect(nameBefore).toHaveProperty("disabled", true);
  expect(screen.getByTestId("create-agent-worktree")).toHaveProperty(
    "disabled",
    true
  );
  const expanded = startingBefore.closest("[aria-hidden]")!;
  expect(expanded.getAttribute("aria-hidden")).toBe("false");
  expect(expanded.hasAttribute("inert")).toBe(false);
  const expandedClass = expanded.className;

  await waitFor(() => expect(project).toHaveProperty("disabled", false));
  fireEvent.click(project);
  const menu = screen.getByRole("listbox");
  expect(
    within(menu).queryByRole("option", { name: "Folder Only" })
  ).toBeNull();
  fireEvent.click(within(menu).getByRole("option", { name: "Sample Project" }));

  const startingBranch = await screen.findByRole("combobox", {
    name: "Starting branch",
  });
  await waitFor(() => expect(finishBranches).toBeDefined());
  expect(startingBranch.closest("[aria-hidden]")?.className).toBe(
    expandedClass
  );
  expect(startingBranch).toHaveProperty("disabled", false);
  await act(async () => {
    finishBranches!({ branches: ["trunk", "release"], defaultBranch: "trunk" });
  });
  expect(startingBranch.closest("[aria-hidden]")?.className).toBe(
    expandedClass
  );
  fireEvent.click(startingBranch);
  await screen.findByRole("option", { name: "trunk" });
  expect(api).toHaveBeenCalledWith("/fixture/runner/branches?projectId=p1");
  fireEvent.click(screen.getByRole("option", { name: "trunk" }));
  expect(submit).toHaveProperty("disabled", false);
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Toggle new branch creation" })
  );
  expect(
    screen.getByRole("combobox", { name: "Starting branch" })
  ).toBeDefined();
});

it.each([true, false])(
  "selects a searched repository by project (existing: %s)",
  async (existing) => {
    mount("codex", catalog, true, "/agents");
    const original = vi.mocked(api).getMockImplementation()!;
    const repository = "https://github.com/example/new-repo";
    const picked = {
      id: "picked",
      name: "new-repo",
      repoRoot: null,
      repository,
    };
    let created = false;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.includes("/repository-search?"))
        return {
          repositories: [{ name: "example/new-repo", url: repository }],
        };
      if (path === "/api/runners")
        return {
          runners: [
            {
              id: "runner-a",
              name: "Runner A",
              status: "online",
              repositoryPicker: true,
            },
          ],
        };
      if (path === "/api/v1/projects" && init?.method === "POST") {
        created = true;
        return picked;
      }
      if (
        path === "/api/v1/projects" ||
        path.startsWith("/api/v1/projects?repository=")
      )
        return existing || created ? [picked] : [];
      if (path === "/api/v1/projects/picked/repository")
        return { url: repository + ".git" };
      const response = (await original(path, init)) as {
        targets: { location: { projects: (typeof picked)[] } }[];
      };
      if (path === "/api/v1/launch-targets" && (existing || created))
        response.targets[1].location.projects.push(picked);
      return response;
    });
    const machine = await screen.findByRole("combobox", { name: "Runs on" });
    fireEvent.keyDown(machine, { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("option", { name: /Runner A/ }));
    await act(async () => {});
    fireEvent.click(screen.getByRole("combobox", { name: "Project" }));
    await screen.findByPlaceholderText(
      "Search projects or your repos, or paste a URL"
    );
    fireEvent.change(
      screen.getByPlaceholderText(
        "Search projects or your repos, or paste a URL"
      ),
      { target: { value: "new-repo" } }
    );
    fireEvent.click(
      await screen.findByRole("option", { name: "example/new-repo" })
    );
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Project" }).textContent
      ).toContain("new-repo")
    );
    const posts = vi
      .mocked(api)
      .mock.calls.filter(
        ([path, init]) => path === "/api/v1/projects" && init?.method === "POST"
      );
    expect(posts).toHaveLength(existing ? 0 : 1);
    if (!existing)
      expect(JSON.parse(posts[0]![1]!.body as string)).toMatchObject({
        repository,
        name: "new-repo",
      });
  }
);

function mountRepositoryPicker() {
  const onRepository = vi.fn();
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RunnerRepositoryPicker
        searchUrl="/fixture/search"
        projectId="linked"
        projects={[
          {
            id: "linked",
            name: "Repo project",
            repository: "https://github.com/acme/repo.git",
            repoRoot: null,
            color: "#9575ed",
            extraRoots: [],
            iconOverride: null,
            createdAt: "",
            updatedAt: "",
          },
        ]}
        onProject={vi.fn()}
        onRepository={onRepository}
      />
    </QueryClientProvider>
  );
  return onRepository;
}

it("shows project repository details and annotates linked repository rows without changing selection", async () => {
  vi.mocked(api).mockResolvedValue({
    repositories: [
      { name: "acme/repo", url: "https://github.com/acme/repo" },
      {
        name: "a-very-long-organization/new-repo",
        url: "https://github.com/a-very-long-organization/new-repo",
      },
    ],
  });
  const onRepository = mountRepositoryPicker();
  fireEvent.click(screen.getByRole("combobox", { name: "Project" }));
  const projectRow = screen.getByRole("option", { name: "Repo project" });
  expect(within(projectRow).getByText("acme/repo")).toBeTruthy();
  expect(within(projectRow).getByLabelText("Selected")).toBeTruthy();
  fireEvent.change(
    screen.getByPlaceholderText(
      "Search projects or your repos, or paste a URL"
    ),
    { target: { value: "repo" } }
  );
  const linked = await screen.findByRole("option", { name: "acme/repo" });
  expect(within(linked).getByLabelText("Repo project")).toBeTruthy();
  expect(within(linked).getByLabelText("Selected")).toBeTruthy();
  const fresh = screen.getByRole("option", {
    name: "a-very-long-organization/new-repo",
  });
  expect(within(fresh).queryByLabelText("Selected")).toBeNull();
  fireEvent.click(fresh);
  expect(onRepository).toHaveBeenCalledWith(
    "https://github.com/a-very-long-organization/new-repo"
  );
});

it("displays a pasted URL as owner/repo while selecting its original URL", async () => {
  const onRepository = mountRepositoryPicker();
  await act(async () => {});
  fireEvent.click(screen.getByRole("combobox", { name: "Project" }));
  const url = "https://github.com/acme/pasted-repo.git";
  fireEvent.change(
    screen.getByPlaceholderText(
      "Search projects or your repos, or paste a URL"
    ),
    { target: { value: url } }
  );
  const option = await screen.findByRole("option", {
    name: "acme/pasted-repo",
  });
  expect(within(option).getByText("pasted-repo")).toBeTruthy();
  fireEvent.click(option);
  expect(onRepository).toHaveBeenCalledWith(url);
});

it("presents search failures as status text rather than selectable rows", async () => {
  vi.mocked(api).mockRejectedValue(new Error("offline"));
  mountRepositoryPicker();
  await act(async () => {});
  fireEvent.click(screen.getByRole("combobox", { name: "Project" }));
  fireEvent.change(
    screen.getByPlaceholderText(
      "Search projects or your repos, or paste a URL"
    ),
    { target: { value: "missing" } }
  );
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe(
      "Couldn’t search repositories."
    )
  );
  expect(screen.queryByRole("option")).toBeNull();
});

it("keeps the list height fixed across loading, results, empty and error states", async () => {
  let finish!: (value: {
    repositories: { name: string; url: string }[];
  }) => void;
  vi.mocked(api).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  mountRepositoryPicker();
  await act(async () => {});
  fireEvent.click(screen.getByRole("combobox", { name: "Project" }));
  const list = screen.getByRole("listbox");
  const fixedClass = list.className;
  expect(fixedClass.split(" ")).toContain("h-80");
  const search = screen.getByPlaceholderText(
    "Search projects or your repos, or paste a URL"
  );
  fireEvent.change(search, { target: { value: "repo" } });
  await waitFor(() => expect(api).toHaveBeenCalled());
  expect(screen.getByText("Your GitHub repositories")).toBeTruthy();
  expect(screen.getByRole("listbox").className).toBe(fixedClass);
  await act(async () => {
    finish({
      repositories: [
        { name: "acme/repo", url: "https://github.com/acme/repo" },
      ],
    });
  });
  await screen.findByRole("option", { name: "acme/repo" });
  expect(screen.getByRole("listbox").className).toBe(fixedClass);
  vi.mocked(api).mockResolvedValue({ repositories: [] });
  fireEvent.change(search, { target: { value: "nothing" } });
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe("No matches.")
  );
  expect(screen.getByRole("listbox").className).toBe(fixedClass);
  vi.mocked(api).mockRejectedValue(new Error("offline"));
  fireEvent.change(search, { target: { value: "offline" } });
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe(
      "Couldn’t search repositories."
    )
  );
  expect(screen.getByRole("listbox").className).toBe(fixedClass);
});
