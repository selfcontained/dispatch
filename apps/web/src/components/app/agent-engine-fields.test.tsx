// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Template } from "@/hooks/use-templates";
import type { TaskColumn } from "@/hooks/use-tasks";
import type { AgentType } from "@/lib/agent-types";
import { CreateAgentDialog } from "./create-agent-dialog";
import { TaskTriggerDialog } from "./tasks/task-trigger-dialog";

const api = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api }));

const enabledAgentTypes: AgentType[] = ["claude", "codex", "opencode"];
const createType = vi.hoisted(() => ({ value: "codex" }));
const templateType = vi.hoisted(() => ({ value: "codex" }));

// Create Agent's form and the fields around the engine block are not what
// this compares; stub them so only the shared block renders for real.
vi.mock("./use-create-agent-form", async () => {
  const { useAgentModelCatalog } =
    await import("@/hooks/use-agent-model-catalog");
  return {
    useCreateAgentForm: () => {
      const models = useAgentModelCatalog(createType.value as AgentType);
      return {
        step: "config",
        createType: createType.value,
        agentTypes: enabledAgentTypes,
        setCreateType: vi.fn(),
        createModel: null,
        createEffort: null,
        setCreateEffort: vi.fn(),
        setCreateModel: vi.fn(),
        modelOptions: models.options,
        defaultModel: models.defaultModel,
        modelCatalogLoading: models.loading,
        createName: "",
        setCreateName: vi.fn(),
        createCwd: "/repo",
        createFullAccess: true,
        locationReady: true,
        launch: {
          list: { data: [], isError: false },
          projection: { isError: false },
          target: undefined,
        },
        targetData: { isError: false },
        engines,
        chooseTarget: vi.fn(),
        creating: false,
      };
    },
  };
});
vi.mock("./project-location", () => ({ ProjectLocation: () => null }));
vi.mock("./agent-persona-select", () => ({ AgentPersonaSelect: () => null }));
vi.mock("./create-agent-worktree-section", () => ({
  WorktreeSection: () => null,
}));

vi.mock("@/hooks/use-templates", async (actual) => ({
  ...(await actual<typeof import("@/hooks/use-templates")>()),
  useTemplates: () => ({
    data: [
      {
        id: "tpl_1",
        name: "Builder",
        directory: "/repo",
        projectId: "p1",
        agentType: templateType.value,
      } as Template,
    ],
  }),
}));
const project = { id: "p1", name: "Repo", repoRoot: "/repo" };
vi.mock("@/hooks/use-projects", () => ({
  useProjects: () => ({ data: [project] }),
  useProjectScope: () => ({ project: undefined, projectId: null }),
}));
vi.mock("@/hooks/use-tasks", () => ({
  useTaskActions: () => ({
    updateColumn: { mutateAsync: vi.fn(), isPending: false },
  }),
}));
vi.mock("@/components/app/dashboard-context", () => ({
  useDashboardContext: () => ({ enabledAgentTypes }),
}));

const engines = [
  {
    id: "claude",
    label: "Claude Code",
    installed: false,
    path: null,
    install: "npm i -g @anthropic-ai/claude-code",
  },
  {
    id: "codex",
    label: "Codex",
    installed: true,
    path: "/opt/homebrew/bin/codex",
    version: "0.155.1",
    install: "npm i -g @openai/codex",
  },
  {
    id: "opencode",
    label: "OpenCode",
    installed: true,
    path: "/usr/local/bin/opencode",
    install: "npm i -g opencode-ai",
  },
];
const models = {
  claude: [{ id: "claude-opus-5-5", label: "Opus 5.5" }],
  codex: [{ id: "gpt-5.5", label: "GPT-5.5" }],
};

beforeAll(() => {
  // Radix measures elements with APIs jsdom doesn't implement.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});
beforeEach(() => {
  api.mockImplementation(async (path: string) => {
    if (path === "/api/v1/launch-targets")
      return {
        targets: [
          {
            key: "fixture",
            dataUrl: "/fixture/data",
            location: { folders: true },
          },
        ],
      };
    if (path.startsWith("/api/v1/launch-targets/saved/"))
      return { targetKey: "fixture" };
    if (path.startsWith("/fixture/data"))
      return {
        catalog: { models },
        agentTypes: enabledAgentTypes,
        engineOptions: engines,
      };
    if (path === "/api/v1/engine-management/status?scope=local")
      return { engines };
    if (path === "/api/v1/agent-models") return { models };
    return [];
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const column = {
  id: "ready",
  name: "Ready",
  key: "ready",
  position: 1,
  trigger: {
    templateId: "tpl_1",
    agentType: null,
    model: null,
    assign: true,
    fireOnCreate: false,
  },
} as unknown as TaskColumn;

const renderHost = (host: "create" | "trigger") => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        {host === "create" ? (
          <CreateAgentDialog
            open
            enabledAgentTypes={enabledAgentTypes}
            initialAgentType={null}
            setOpen={vi.fn()}
            resolveDefaultCwd={() => "/repo"}
            onCreated={vi.fn()}
          />
        ) : (
          <TaskTriggerDialog
            column={column}
            projectId="p1"
            open
            onOpenChange={vi.fn()}
            returnFocus={{ current: null }}
          />
        )}
      </MemoryRouter>
    </QueryClientProvider>
  );
};

/**
 * The block the Type picker sits in, with the host's ids made neutral. Radix
 * adds a hidden native select only inside a <form>, which Create Agent is.
 * The trigger dialog omits the catalog default prop.
 */
const engineBlock = () => {
  const type = screen.getByRole("combobox", { name: /^(Agent|Type)$/ });
  const block = type.parentElement!.parentElement!.parentElement!;
  return block.outerHTML
    .replace(">Agent</label>", ">Type</label>")
    .replace(">Use engine setting</span>", ">Default</span>")
    .replace(/task-trigger-type/g, "agent-type-select")
    .replace(/task-trigger-(model|engine|effort)/g, "create-agent-$1")
    .replace(/radix-[^"]*/g, "radix")
    .replace(/<select aria-hidden="true".*?<\/select>/g, "")
    .replace(/:r[0-9a-z]+:/g, "id");
};

const settle = async (expectModel: boolean, missing = false) => {
  await waitFor(() => {
    expect(screen.queryByText("Loading models…")).toBeNull();
    expect(screen.queryAllByText("Model")).toHaveLength(expectModel ? 1 : 0);
  });
  // Engines arrive on their own query; only a missing one says anything.
  if (missing) await screen.findByTestId("agent-type-missing-note");
};

const blockIn = async (
  host: "create" | "trigger",
  expectModel: boolean,
  missing = false
) => {
  renderHost(host);
  await settle(expectModel, missing);
  const html = engineBlock();
  cleanup();
  return html;
};

it("renders the installed engine's block the same in both hosts", async () => {
  createType.value = templateType.value = "codex";
  renderHost("trigger");
  await settle(true);
  // Main names the installed engine under the shared configuration row.
  expect(screen.getByTestId("task-trigger-engine").textContent).toContain(
    "/opt/homebrew/bin/codex"
  );
  expect(screen.getByRole("combobox", { name: "Type" }).textContent).toContain(
    "Codex"
  );
  expect(
    screen.getByRole("combobox", { name: "Type" }).parentElement!.parentElement!
      .className
  ).toContain("grid-cols-[minmax(6rem,1fr)_minmax(0,1.4fr)_4.75rem]");
  cleanup();

  const create = await blockIn("create", true);
  const trigger = await blockIn("trigger", true);
  expect(trigger).toBe(create);
});

it("says what to install for a missing engine in both hosts", async () => {
  createType.value = templateType.value = "claude";
  renderHost("trigger");
  await settle(true, true);
  expect(screen.getByTestId("agent-type-missing-note").textContent).toContain(
    "npm i -g @anthropic-ai/claude-code"
  );
  cleanup();

  const create = await blockIn("create", true, true);
  const trigger = await blockIn("trigger", true, true);
  expect(trigger).toBe(create);
});

it("keeps the Model field in Create Agent without a catalog", async () => {
  createType.value = templateType.value = "opencode";
  const create = await blockIn("create", true);
  const trigger = await blockIn("trigger", false);
  expect(create).toContain("create-agent-model");
  expect(trigger).toContain("grid-cols-[minmax(0,1fr)_4.75rem]");
  expect(trigger).toContain("/usr/local/bin/opencode");
});
