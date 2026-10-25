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
        setCreateType: vi.fn(),
        createModel: null,
        setCreateModel: vi.fn(),
        modelOptions: models.options,
        modelCatalogLoading: models.loading,
        createName: "",
        setCreateName: vi.fn(),
        createCwd: "/repo",
        createFullAccess: true,
        locationReady: true,
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
    if (path === "/api/v1/system/engines") return { engines };
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
 */
const engineBlock = () => {
  const type = screen.getByRole("combobox", { name: "Type" });
  const block = type.parentElement!.parentElement!.parentElement!;
  return block.outerHTML
    .replace(/task-trigger-type/g, "agent-type-select")
    .replace(/task-trigger-(model|engine)/g, "create-agent-$1")
    .replace(/radix-[^"]*/g, "radix")
    .replace(/<select aria-hidden="true".*?<\/select>/g, "")
    .replace(/:r[0-9a-z]+:/g, "id");
};

const settle = async (expectModel: boolean) => {
  await waitFor(() => {
    expect(screen.queryByText(/Loading models/)).toBeNull();
    expect(screen.queryAllByText("Model")).toHaveLength(expectModel ? 1 : 0);
  });
  // Engines arrive on their own query: the summary line or the install hint.
  await waitFor(() =>
    expect(
      screen.queryAllByTestId(/-engine$|^agent-type-missing-note$/)
    ).not.toHaveLength(0)
  );
};

const blockIn = async (host: "create" | "trigger", expectModel: boolean) => {
  renderHost(host);
  await settle(expectModel);
  const html = engineBlock();
  cleanup();
  return html;
};

it("renders the installed engine's block the same in both hosts", async () => {
  createType.value = templateType.value = "codex";
  renderHost("trigger");
  await settle(true);
  await screen.findByText("Codex 0.155.1 · /opt/homebrew/bin/codex");
  expect(screen.getByRole("combobox", { name: "Type" }).textContent).toContain(
    "Codex"
  );
  expect(
    screen.getByRole("combobox", { name: "Type" }).parentElement!.parentElement!
      .className
  ).toContain("min-[420px]:grid-cols-2");
  cleanup();

  const create = await blockIn("create", true);
  const trigger = await blockIn("trigger", true);
  expect(trigger).toBe(create);
});

it("says what to install for a missing engine in both hosts", async () => {
  createType.value = templateType.value = "claude";
  renderHost("trigger");
  await settle(true);
  await screen.findByTestId("agent-type-missing-note");
  expect(screen.getByTestId("agent-type-missing-note").textContent).toContain(
    "npm i -g @anthropic-ai/claude-code"
  );
  cleanup();

  const create = await blockIn("create", true);
  const trigger = await blockIn("trigger", true);
  expect(trigger).toBe(create);
});

it("hides the model picker without a catalog in both hosts", async () => {
  createType.value = templateType.value = "opencode";
  const create = await blockIn("create", false);
  const trigger = await blockIn("trigger", false);
  expect(trigger).toBe(create);
  expect(trigger).not.toContain("min-[420px]:grid-cols-2");
  expect(trigger).toContain("OpenCode · /usr/local/bin/opencode");
});
