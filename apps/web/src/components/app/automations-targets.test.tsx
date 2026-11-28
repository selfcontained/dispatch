// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CreateTemplateDialog } from "./automations-create-dialog";
import { TemplateDetailPane } from "./automations-template-detail";
vi.mock("@/lib/api", () => ({ api: vi.fn() }));
vi.mock("@/hooks/use-projects", () => ({
  useProjectScope: () => ({ project: null }),
  useProjects: () => ({
    data: [{ id: "project", name: "Repository", repoRoot: "/repo" }],
    isSuccess: true,
  }),
}));
const request = vi.mocked(api);
const controller = {
  key: "opaque-controller",
  name: "Local",
  status: "online",
  dataUrl: "/fixture/controller",
  location: { kind: "folder" },
  launchFields: {},
  selectionFields: { runner: "controller" },
};
const enrolled = {
  key: "opaque-enrolled",
  name: "Fixture runner",
  status: "offline",
  dataUrl: "/fixture/enrolled",
  location: {
    kind: "project",
    projects: [
      {
        id: "project",
        name: "Repository",
        repoRoot: "/repo",
        repository: "https://github.com/org/repo",
      },
    ],
  },
  launchFields: { runner: "fixture" },
  selectionFields: { runner: "fixture" },
};
beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(() => {
  cleanup();
  request.mockReset();
});
function fixture(
  targets = [controller],
  template?: Record<string, unknown>,
  models: { id: string; label: string }[] = []
) {
  request.mockImplementation(async (url, init) => {
    if (url === "/api/v1/launch-targets") return { targets };
    if (url.startsWith("/api/v1/launch-targets/saved/"))
      return {
        targetKey: template?.runner ? enrolled.key : controller.key,
        projectId: "project",
        directory: "",
      };
    if (url === "/fixture/branches")
      return { branches: ["main"], defaultBranch: "main" };
    if (url.startsWith("/fixture/"))
      return {
        agentTypes: url.startsWith(enrolled.dataUrl)
          ? ["codex"]
          : ["claude", "codex"],
        catalog: { models: { claude: models, codex: models } },
        engineOptions: [],
        effort: [],
        directory: url.startsWith(enrolled.dataUrl) ? "" : "/repo",
        branchesUrl: "/fixture/branches",
        personasUrl: "/api/v1/personas?fixture",
        defaults: {
          baseBranch: url.startsWith(enrolled.dataUrl) ? "" : "main",
          preferenceKey: url,
          templateFields: url.startsWith(enrolled.dataUrl)
            ? { directory: "", runner: "fixture" }
            : {},
        },
      };
    if (url === "/api/v1/templates")
      return init
        ? { id: "created", ...JSON.parse(String(init.body)) }
        : template
          ? [template]
          : [];
    if (url.startsWith("/api/v1/templates/") && init?.method === "PATCH")
      return { ...template, ...JSON.parse(String(init.body)) };
    if (url.startsWith("/api/v1/personas")) return { personas: [] };
    if (url.startsWith("/api/v1/history/projects")) return { projects: [] };
    if (url.includes("path-info"))
      return { exists: true, isDirectory: true, isGitRepo: true };
    if (url.includes("path-completions")) return { completions: [] };
    return {};
  });
}
function mount(content: React.ReactNode, route = "/") {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={[route]}>
        <TooltipProvider>{content}</TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}
it("pins main's new-template payload and hides the runner control when no runner is enrolled", async () => {
  fixture();
  mount(
    <CreateTemplateDialog
      open
      onOpenChange={vi.fn()}
      enabledAgentTypes={["claude", "codex"]}
    />
  );
  expect(screen.queryByTestId("runner-picker")).toBeNull();
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Persona" }), {
    key: "Enter",
  });
  const status = await screen.findByRole("option", {
    name: "Choose a directory first",
  });
  expect(status).toBeTruthy();
  fireEvent.keyDown(status, { key: "Escape" });
  fireEvent.change(screen.getByPlaceholderText("template name"), {
    target: { value: "Nightly" },
  });
  fireEvent.change(screen.getByPlaceholderText("/path/to/repo"), {
    target: { value: "/repo" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create template" }));
  await waitFor(() =>
    expect(
      request.mock.calls.some(
        ([url, init]) => url === "/api/v1/templates" && init?.method === "POST"
      )
    ).toBe(true)
  );
  const init = request.mock.calls.find(
    ([url, init]) => url === "/api/v1/templates" && init?.method === "POST"
  )![1]!;
  expect(JSON.parse(String(init.body))).toEqual({
    name: "Nightly",
    directory: "/repo",
    model: null,
    projectId: null,
    effort: null,
    persona: null,
    description: null,
    prompt: null,
    agentType: "claude",
    useWorktree: false,
    baseBranch: null,
    branchName: null,
    fullAccess: false,
    callable: true,
    allowFiles: true,
    selfImprove: false,
  });
});
it.each(["release/unlisted", "https://github.com/org/repo/pull/7"])(
  "reopens and saves the offered runner template with %s unchanged",
  async (baseBranch) => {
    const template = {
      id: "saved",
      name: "Nightly",
      directory: "",
      runner: "fixture",
      projectId: "project",
      agentType: "codex",
      model: null,
      useWorktree: true,
      baseBranch,
      branchName: null,
      fullAccess: false,
      callable: true,
      allowFiles: true,
      selfImprove: false,
    };
    fixture([controller, enrolled], template);
    mount(
      <Routes>
        <Route
          path="/automations/templates/:templateId"
          element={
            <TemplateDetailPane enabledAgentTypes={["claude", "codex"]} />
          }
        />
      </Routes>,
      "/automations/templates/saved"
    );
    await screen.findByRole("heading", { name: "Nightly" });
    await waitFor(() =>
      expect(screen.getByTestId("create-agent-runner").textContent).toContain(
        "Fixture runner"
      )
    );
    expect(screen.queryByPlaceholderText("/path/to/repo")).toBeNull();
    expect(
      screen.getByTestId("template-worktree-base-branch").textContent
    ).toBe(baseBranch);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved.");
    const init = request.mock.calls.find(
      ([, init]) => init?.method === "PATCH"
    )![1]!;
    const payload = JSON.parse(String(init.body));
    expect(payload.baseBranch).toBe(baseBranch);
    expect(payload).not.toHaveProperty("runner");
    expect(payload).not.toHaveProperty("directory");
  }
);
it("puts the target first and re-derives the engine and required project for an offline fixture", async () => {
  fixture([controller, enrolled]);
  mount(
    <CreateTemplateDialog
      open
      onOpenChange={vi.fn()}
      enabledAgentTypes={["claude", "codex"]}
    />
  );
  fireEvent.keyDown(await screen.findByTestId("create-agent-runner"), {
    key: "Enter",
  });
  fireEvent.click(
    await screen.findByRole("option", { name: /Fixture runner/ })
  );
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "Agent type" }).textContent
    ).toContain("Codex")
  );
  expect(screen.queryByPlaceholderText("/path/to/repo")).toBeNull();
  expect(
    screen
      .getByRole("button", { name: "Create template" })
      .hasAttribute("disabled")
  ).toBe(true);
  fireEvent.click(screen.getByTestId("create-agent-runner-project"));
  fireEvent.click(await screen.findByRole("option", { name: "Repository" }));
  fireEvent.change(screen.getByPlaceholderText("template name"), {
    target: { value: "Fixture template" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create template" }));
  await waitFor(() =>
    expect(request.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
      true
    )
  );
  const payload = JSON.parse(
    String(
      request.mock.calls.find(([, init]) => init?.method === "POST")![1]!.body
    )
  );
  expect(payload).toMatchObject({
    runner: "fixture",
    projectId: "project",
    agentType: "codex",
    useWorktree: false,
  });
});

it.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])(
  "matches main's settled model visibility (runner=%s, populated=%s)",
  async (runner, populated) => {
    const template = {
      id: "saved",
      name: "Nightly",
      directory: runner ? "" : "/repo",
      runner: runner ? "fixture" : null,
      projectId: "project",
      agentType: "codex",
      model: null,
      useWorktree: false,
      baseBranch: null,
      branchName: null,
      fullAccess: false,
      callable: true,
      allowFiles: true,
      selfImprove: false,
    };
    fixture(
      [controller, enrolled],
      template,
      populated ? [{ id: "fixture-model", label: "Fixture model" }] : []
    );
    mount(
      <Routes>
        <Route
          path="/automations/templates/:templateId"
          element={
            <TemplateDetailPane enabledAgentTypes={["claude", "codex"]} />
          }
        />
      </Routes>,
      "/automations/templates/saved"
    );
    await screen.findByRole("heading", { name: "Nightly" });
    await waitFor(() =>
      expect(
        request.mock.calls.some(([url]) =>
          url.startsWith(runner ? enrolled.dataUrl : controller.dataUrl)
        )
      ).toBe(true)
    );
    await waitFor(() =>
      expect(screen.queryByText("Loading models…")).toBeNull()
    );
    expect(Boolean(screen.queryByRole("combobox", { name: "Model" }))).toBe(
      populated
    );
  }
);
