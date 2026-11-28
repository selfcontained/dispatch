// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import type { Job } from "@/hooks/use-jobs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AddJobDialog, AddJobFlow } from "./jobs-add-dialog";
import { SettingsTab } from "./jobs-settings-tab";

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
  name: "This computer",
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

function fixture(targets: object[], savedOnRunner = false) {
  request.mockImplementation(async (url: string) => {
    if (url === "/api/v1/launch-targets") return { targets };
    if (url.startsWith("/api/v1/launch-targets/saved/"))
      return {
        targetKey: savedOnRunner ? enrolled.key : controller.key,
        projectId: "project",
        directory: savedOnRunner ? "" : "/repo",
      };
    if (url.startsWith("/fixture/"))
      return {
        agentTypes: ["codex"],
        catalog: {
          models: { codex: [{ id: "runner-model", label: "Runner model" }] },
        },
        engineOptions: [],
        effort: [],
        directory: "",
        branchesUrl: "/fixture/branches",
        personasUrl: "/api/v1/personas?fixture",
        defaults: { baseBranch: "", preferenceKey: url },
      };
    if (url === "/api/v1/agent-models")
      return { models: { claude: [], codex: [] } };
    if (url.startsWith("/api/v1/personas")) return { personas: [] };
    if (url.startsWith("/api/v1/history/projects")) return { projects: [] };
    return {};
  });
}

function mount(content: React.ReactNode) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <TooltipProvider>{content}</TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

async function chooseRunner() {
  fireEvent.keyDown(await screen.findByTestId("create-agent-runner"), {
    key: "Enter",
  });
  fireEvent.click(
    await screen.findByRole("option", { name: /Fixture runner/ })
  );
}

async function chooseProject() {
  fireEvent.keyDown(await screen.findByTestId("create-agent-runner-project"), {
    key: "Enter",
  });
  fireEvent.click(await screen.findByRole("option", { name: "Repository" }));
}

it("hides Runs on and keeps the folder form when no runner is enrolled", async () => {
  fixture([controller]);
  mount(
    <AddJobDialog open onOpenChange={vi.fn()}>
      <AddJobFlow
        onAddJob={vi.fn()}
        isAdding={false}
        enabledAgentTypes={["claude", "codex"]}
      />
    </AddJobDialog>
  );
  expect(await screen.findByTestId("job-directory-input")).toBeTruthy();
  await waitFor(() =>
    expect(
      request.mock.calls.some(([url]) => url === "/api/v1/launch-targets")
    ).toBe(true)
  );
  expect(screen.queryByTestId("runner-picker")).toBeNull();
});

it("creates a job on a runner with its project, engines and models", async () => {
  fixture([controller, enrolled]);
  const onAddJob = vi.fn().mockResolvedValue(undefined);
  mount(
    <AddJobDialog open onOpenChange={vi.fn()}>
      <AddJobFlow
        onAddJob={onAddJob}
        isAdding={false}
        enabledAgentTypes={["claude", "codex"]}
      />
    </AddJobDialog>
  );
  await chooseRunner();
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "Agent type" }).textContent
    ).toContain("Codex")
  );
  expect(screen.queryByTestId("job-directory-input")).toBeNull();
  fireEvent.change(screen.getByLabelText("Name"), {
    target: { value: "Nightly" },
  });
  fireEvent.change(screen.getByLabelText("Task prompt"), {
    target: { value: "Do it." },
  });
  const create = screen.getByRole("button", { name: "Create job" });
  expect(create.hasAttribute("disabled")).toBe(true);
  await chooseProject();
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Model" }), {
    key: "Enter",
  });
  fireEvent.click(await screen.findByRole("option", { name: "Runner model" }));
  fireEvent.click(create);
  await waitFor(() => expect(onAddJob).toHaveBeenCalled());
  expect(onAddJob.mock.calls[0]![0]).toMatchObject({
    runner: "fixture",
    projectId: "project",
    directory: "",
    agentType: "codex",
    model: "runner-model",
  });
});

it("reads a saved runner job's target through its template and saves without a folder", async () => {
  fixture([controller, enrolled], true);
  const onUpdateJob = vi.fn().mockResolvedValue(undefined);
  const job = {
    id: "job_1",
    directory: "",
    projectId: "project",
    name: "nightly",
    schedule: null,
    timeoutMs: 1_800_000,
    needsInputTimeoutMs: 86_400_000,
    prompt: "Do it.",
    enabled: false,
    agentType: "codex",
    model: null,
    effort: null,
    persona: null,
    useWorktree: false,
    baseBranch: null,
    branchName: null,
    fullAccess: false,
    autoArchive: true,
    callable: false,
    singleton: true,
    webhookEnabled: false,
    webhookSecret: null,
    templateId: "template_1",
    continuationEnabled: false,
  } as unknown as Job;
  mount(
    <SettingsTab
      job={job}
      enabledAgentTypes={["claude", "codex"]}
      onUpdateJob={onUpdateJob}
      onRemoveJob={vi.fn()}
      isUpdating={false}
      isRemoving={false}
    />
  );
  await waitFor(() =>
    expect(screen.getByTestId("create-agent-runner").textContent).toContain(
      "Fixture runner"
    )
  );
  expect(
    screen.getByTestId("create-agent-runner-project").textContent
  ).toContain("Repository");
  expect(
    request.mock.calls.some(
      ([url]) => url === "/api/v1/launch-targets/saved/template/template_1"
    )
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onUpdateJob).toHaveBeenCalled());
  const payload = onUpdateJob.mock.calls[0]![0];
  expect(payload).not.toHaveProperty("directory");
  expect(payload).not.toHaveProperty("runner");
});
