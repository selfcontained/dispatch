// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Template } from "@/hooks/use-templates";
import type { TaskColumn } from "@/hooks/use-tasks";
import { TaskTriggerDialog } from "./task-trigger-dialog";

const api = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api }));

const templates = vi.hoisted(() => [] as Template[]);
const addTemplate = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-templates", async (actual) => ({
  ...(await actual<typeof import("@/hooks/use-templates")>()),
  useTemplates: () => ({ data: templates }),
  useTemplateActions: () => ({ addTemplate: { mutateAsync: addTemplate } }),
}));

const project = { id: "p1", name: "Repo", repoRoot: "/repo" };
vi.mock("@/hooks/use-projects", () => ({
  useProjects: () => ({ data: [project] }),
  useProjectScope: () => ({ project: undefined, projects: [project] }),
}));

const updateColumn = vi.fn();
vi.mock("@/hooks/use-tasks", () => ({
  useTaskActions: () => ({
    updateColumn: { mutateAsync: updateColumn, isPending: false },
  }),
}));

vi.mock("@/components/app/dashboard-context", () => ({
  useDashboardContext: () => ({ enabledAgentTypes: ["claude", "codex"] }),
}));

vi.mock("@/hooks/use-agent-model-catalog", () => ({
  useAgentModelCatalog: () => ({
    options: [{ id: "m1", label: "Model One" }],
    loading: false,
    loaded: true,
    normalizeModel: (model: string | null) => model,
  }),
}));

beforeAll(() => {
  // Radix Select measures and captures pointers jsdom doesn't implement.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});
const template = (id: string, name: string, directory = "/repo") =>
  ({ id, name, directory, projectId: "p1", agentType: "claude" }) as Template;
beforeEach(() => {
  api.mockResolvedValue([]);
  templates.splice(0, templates.length, template("tpl_1", "Builder"));
  addTemplate.mockImplementation(async (input: Partial<Template>) => {
    // Stands in for the refetch the real mutation's invalidation triggers.
    const created = { ...template("tpl_new", input.name!), ...input };
    templates.push(created);
    return created;
  });
  updateColumn.mockResolvedValue({});
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
    assign: false,
    fireOnCreate: false,
  },
} as unknown as TaskColumn;

const renderDialog = () => {
  const onOpenChange = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TaskTriggerDialog
          column={column}
          projectId="p1"
          open
          onOpenChange={onOpenChange}
          returnFocus={{ current: null }}
        />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { onOpenChange };
};
// The stacked create dialog aria-hides the trigger dialog behind it.
const templatePicker = () =>
  screen.getByRole("combobox", { name: "Template", hidden: true });
const openNewTemplate = () => {
  fireEvent.keyDown(templatePicker(), { key: "Enter" });
  fireEvent.click(screen.getByRole("option", { name: /New template/ }));
};

it("creates a template from the picker and selects it", async () => {
  const { onOpenChange } = renderDialog();
  expect(templatePicker().textContent).toBe("Builder");
  openNewTemplate();
  await screen.findByRole("heading", { name: "Create Template" });
  expect(templatePicker().textContent).toBe("Builder");
  // Locked to the board's project: no project/folder switch, no path input.
  expect(screen.queryByTestId("project-location")).toBeNull();
  expect(screen.queryByPlaceholderText("/path/to/repo")).toBeNull();
  expect(screen.getByTestId("locked-location").textContent).toBe(
    "ProjectRepo/repo"
  );
  fireEvent.change(screen.getByPlaceholderText(/name/i), {
    target: { value: "Reviewer" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("heading", { name: "Create Template" })
    ).toBeNull()
  );
  expect(addTemplate).toHaveBeenCalledWith(
    expect.objectContaining({
      name: "Reviewer",
      directory: "/repo",
      projectId: "p1",
    })
  );
  // The created template is one of the board's project templates.
  expect(templates.at(-1)).toMatchObject({ id: "tpl_new", projectId: "p1" });
  expect(templatePicker().textContent).toBe("Reviewer");
  expect(onOpenChange).not.toHaveBeenCalled();
  // The other fields kept their state; Save stores the new template.
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(updateColumn).toHaveBeenCalledWith({
      id: "ready",
      trigger: { ...column.trigger, templateId: "tpl_new" },
    })
  );
});

it("cancel returns to the trigger unchanged", async () => {
  const { onOpenChange } = renderDialog();
  openNewTemplate();
  fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("heading", { name: "Create Template" })
    ).toBeNull()
  );
  expect(addTemplate).not.toHaveBeenCalled();
  expect(templatePicker().textContent).toBe("Builder");
  expect(screen.getByRole("heading", { name: /Trigger · Ready/ })).toBeTruthy();
  expect(onOpenChange).not.toHaveBeenCalled();
});

it("tells same-named templates apart by directory", () => {
  templates.push(template("tpl_2", "Builder", "/repo/apps/web"));
  renderDialog();
  fireEvent.keyDown(templatePicker(), { key: "Enter" });
  expect(
    screen.getAllByRole("option").map((option) => option.textContent)
  ).toEqual(["None", "Builderrepo", "Builderweb", "New template…"]);
});

it("keeps the template's engine until another is picked", async () => {
  renderDialog();
  const type = screen.getByRole("combobox", { name: "Type" });
  // Null resolves to the template's engine, shown beside the model.
  expect(type.textContent).toBe("Claude");
  expect(screen.getByRole("combobox", { name: "Model" })).toBeTruthy();
  fireEvent.click(type);
  // The app's enabled engines, not a fixed list.
  expect(
    screen.getAllByRole("option").map((option) => option.textContent)
  ).toEqual(["Claude", "Codex"]);
  fireEvent.click(screen.getByRole("option", { name: "Codex" }));
  expect(type.textContent).toBe("Codex");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(updateColumn).toHaveBeenCalledWith({
      id: "ready",
      trigger: { ...column.trigger, agentType: "codex" },
    })
  );
});

it("picking the template's engine again goes back to following it", async () => {
  renderDialog();
  const type = screen.getByRole("combobox", { name: "Type" });
  fireEvent.click(type);
  fireEvent.click(screen.getByRole("option", { name: "Codex" }));
  fireEvent.click(type);
  fireEvent.click(screen.getByRole("option", { name: "Claude" }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(updateColumn).toHaveBeenCalledWith({
      id: "ready",
      trigger: column.trigger,
    })
  );
});
