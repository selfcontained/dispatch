// @vitest-environment jsdom
import { useRef, useState } from "react";
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

const renderDialog = (targetColumn = column) => {
  const onOpenChange = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const Harness = () => {
    const [open, setOpen] = useState(true);
    const returnFocus = useRef<HTMLButtonElement>(null);
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <button ref={returnFocus} onClick={() => setOpen(true)}>
            Open trigger
          </button>
          <TaskTriggerDialog
            column={targetColumn}
            projectId="p1"
            open={open}
            onOpenChange={(next) => {
              onOpenChange(next);
              setOpen(next);
            }}
            returnFocus={returnFocus}
          />
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
  render(<Harness />);
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

it.each(["add", "edit"] as const)(
  "cancel discards all %s drafts and restores persisted values on reopen",
  async (mode) => {
    const persisted =
      mode === "edit"
        ? { ...column.trigger!, agentType: "codex" as const, model: "m1" }
        : undefined;
    // Keep this exact object across close/reopen to catch identity-only resets.
    const targetColumn = { ...column, trigger: persisted } as TaskColumn;
    templates.push(template("tpl_2", "Reviewer"));
    const { onOpenChange } = renderDialog(targetColumn);
    const pick = (name: string, option: string) => {
      fireEvent.keyDown(screen.getByRole("combobox", { name }), {
        key: "Enter",
      });
      fireEvent.click(screen.getByRole("option", { name: option }));
    };
    const assign = () =>
      screen.getByRole("checkbox", { name: "Assign the launched agent" });
    const fireOnCreate = () =>
      screen.getByRole("checkbox", { name: "Also fire when created here" });

    pick("Template", "Reviewer");
    pick("Type", mode === "edit" ? "Claude" : "Codex");
    pick("Model", mode === "edit" ? "Default" : "Model One");
    fireEvent.click(assign());
    fireEvent.click(fireOnCreate());
    expect(templatePicker().textContent).toBe("Reviewer");
    expect(screen.getByRole("combobox", { name: "Type" }).textContent).toBe(
      mode === "edit" ? "Claude" : "Codex"
    );
    expect(screen.getByRole("combobox", { name: "Model" }).textContent).toBe(
      mode === "edit" ? "Default" : "Model One"
    );
    expect(assign().getAttribute("aria-checked")).toBe(
      mode === "edit" ? "true" : "false"
    );
    expect(fireOnCreate().getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(updateColumn).not.toHaveBeenCalled();
    expect(addTemplate).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Open trigger" })
      )
    );

    fireEvent.click(screen.getByRole("button", { name: "Open trigger" }));
    expect(templatePicker().textContent).toBe(
      mode === "edit" ? "Builder" : "None"
    );
    expect(screen.getByRole("combobox", { name: "Type" }).textContent).toBe(
      mode === "edit" ? "Codex" : "Claude"
    );
    expect(screen.getByRole("combobox", { name: "Model" }).textContent).toBe(
      mode === "edit" ? "Model One" : "Default"
    );
    expect(assign().getAttribute("aria-checked")).toBe(
      mode === "edit" ? "false" : "true"
    );
    expect(fireOnCreate().getAttribute("aria-checked")).toBe("false");
    expect(
      screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")
    ).toBe(mode === "add");
    expect(updateColumn).not.toHaveBeenCalled();
  }
);
