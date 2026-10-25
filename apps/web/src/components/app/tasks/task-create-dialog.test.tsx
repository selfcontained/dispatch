// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { Task, TaskColumn } from "@/hooks/use-tasks";
import type { Agent } from "@/components/app/types";
import { TaskCreateDialog } from "./task-create-dialog";

const create = vi.fn();
const update = vi.fn();
// The assignee chips read the current turn's step through React Query,
// which this dialog test does not stand up.
vi.mock("@/hooks/use-agent-turn-label", () => ({
  useAgentTurnLabel: () => null,
}));
vi.mock("@/hooks/use-tasks", () => ({
  useTaskActions: () => ({
    create: { mutateAsync: create },
    update: { mutateAsync: update },
  }),
}));

beforeAll(() => {
  // Radix Select measures and captures pointers jsdom doesn't implement.
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});
beforeEach(() => {
  create.mockResolvedValue({ id: "tsk_new" } as Task);
  update.mockResolvedValue({});
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const column = (id: string, name: string, position: number) =>
  ({ id, name, key: id, position, trigger: null }) as unknown as TaskColumn;
const columns = [
  column("backlog", "Backlog", 0),
  column("ready", "Ready", 1),
  column("doing", "Doing", 2),
];
const agents = [
  { id: "a1", name: "builder", status: "running", projectId: "p1" },
] as unknown as Agent[];

const renderDialog = (columnId?: string | null) => {
  const onCreated = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <TaskCreateDialog
      open
      onOpenChange={onOpenChange}
      projectId="p1"
      columns={columns}
      agents={agents}
      columnId={columnId}
      onCreated={onCreated}
    />
  );
  return { onCreated, onOpenChange };
};
const pick = (name: string, option: RegExp) => {
  fireEvent.keyDown(screen.getByRole("combobox", { name }), { key: "Enter" });
  fireEvent.click(screen.getByRole("option", { name: option }));
};

it("needs a title before it creates anything", () => {
  renderDialog();
  const submit = screen.getByRole("button", { name: "Create task" });
  expect((submit as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Title"), {
    target: { value: "   " },
  });
  fireEvent.submit(submit.closest("form")!);
  expect((submit as HTMLButtonElement).disabled).toBe(true);
  expect(create).not.toHaveBeenCalled();
});

it("opens on the column it was started from, else the first", () => {
  renderDialog("ready");
  expect(screen.getByRole("combobox", { name: "Column" }).textContent).toBe(
    "Ready"
  );
  cleanup();
  renderDialog();
  expect(screen.getByRole("combobox", { name: "Column" }).textContent).toBe(
    "Backlog"
  );
});

it("creates from Enter in the title with description and column", async () => {
  const { onCreated, onOpenChange } = renderDialog("ready");
  fireEvent.change(screen.getByLabelText("Description"), {
    target: { value: "## Deliverable\nA thing" },
  });
  const title = screen.getByLabelText("Title");
  expect(document.activeElement).toBe(title);
  fireEvent.change(title, { target: { value: " Ship it " } });
  fireEvent.submit(title.closest("form")!);
  await waitFor(() => expect(onCreated).toHaveBeenCalled());
  expect(create).toHaveBeenCalledWith({
    projectId: "p1",
    title: "Ship it",
    body: "## Deliverable\nA thing",
    columnId: "ready",
  });
  expect(update).not.toHaveBeenCalled();
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it("creates from ⌘Enter in the description and then assigns", async () => {
  const { onCreated } = renderDialog();
  fireEvent.change(screen.getByLabelText("Title"), {
    target: { value: "Assigned task" },
  });
  pick("Column", /Doing/);
  pick("Assignee", /builder/);
  const description = screen.getByLabelText("Description");
  fireEvent.keyDown(description, { key: "Enter" });
  expect(create).not.toHaveBeenCalled();
  // jsdom has no requestSubmit; route it to a submit event.
  const form = description.closest("form")!;
  form.requestSubmit = () => fireEvent.submit(form);
  fireEvent.keyDown(description, { key: "Enter", metaKey: true });
  await waitFor(() => expect(onCreated).toHaveBeenCalled());
  expect(create).toHaveBeenCalledWith({
    projectId: "p1",
    title: "Assigned task",
    columnId: "doing",
  });
  expect(update).toHaveBeenCalledWith({ id: "tsk_new", assignedAgentId: "a1" });
});

it("keeps the form open with the error when creating fails", async () => {
  create.mockRejectedValueOnce(new Error("Project is archived"));
  const { onCreated, onOpenChange } = renderDialog();
  const title = screen.getByLabelText("Title");
  fireEvent.change(title, { target: { value: "Doomed" } });
  fireEvent.submit(title.closest("form")!);
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Project is archived"
  );
  expect(onCreated).not.toHaveBeenCalled();
  expect(onOpenChange).not.toHaveBeenCalledWith(false);
});

it("retries only the assignment when it fails after creating", async () => {
  update.mockRejectedValueOnce(new Error("Agent is archived"));
  const { onCreated, onOpenChange } = renderDialog();
  const title = screen.getByLabelText("Title");
  fireEvent.change(title, { target: { value: "Assign me" } });
  pick("Assignee", /builder/);
  fireEvent.submit(title.closest("form")!);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Task created; assigning failed — retry."
  );
  expect(onCreated).not.toHaveBeenCalled();
  const retry = screen.getByRole("button", { name: "Retry assignment" });
  fireEvent.click(retry);
  await waitFor(() =>
    expect(onCreated).toHaveBeenCalledWith({ id: "tsk_new" })
  );
  expect(create).toHaveBeenCalledTimes(1);
  expect(update).toHaveBeenCalledTimes(2);
  expect(update).toHaveBeenLastCalledWith({
    id: "tsk_new",
    assignedAgentId: "a1",
  });
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it("lands on the created task when closed after a failed assignment", async () => {
  update.mockRejectedValueOnce(new Error("Agent is archived"));
  const { onCreated } = renderDialog();
  const title = screen.getByLabelText("Title");
  fireEvent.change(title, { target: { value: "Assign me" } });
  pick("Assignee", /builder/);
  fireEvent.submit(title.closest("form")!);
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onCreated).toHaveBeenCalledWith({ id: "tsk_new" });
  expect(create).toHaveBeenCalledTimes(1);
});

it("adds and removes files and links before creating with context", async () => {
  renderDialog();
  const file = new File(["context"], "context.txt", { type: "text/plain" });
  const input = screen.getByTestId("task-context-files-input");
  fireEvent.change(input, { target: { files: [file] } });
  expect(screen.getByTestId("context-file-item")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove context.txt" }));
  expect(screen.queryByTestId("context-file-item")).toBeNull();
  fireEvent.change(input, { target: { files: [file] } });
  const addLink = async () => {
    fireEvent.click(screen.getByTestId("task-context-files-button"));
    fireEvent.click(screen.getByRole("button", { name: "Add link" }));
    fireEvent.change(screen.getByLabelText("Link URL"), {
      target: { value: "https://example.com/context" },
    });
    fireEvent.click(screen.getByTestId("task-context-link-add"));
  };
  await addLink();
  fireEvent.click(
    screen.getByRole("button", { name: "Remove https://example.com/context" })
  );
  expect(
    screen.queryByRole("button", { name: "Remove https://example.com/context" })
  ).toBeNull();
  await addLink();
  fireEvent.change(screen.getByLabelText("Title"), {
    target: { value: "Context task" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create task" }));
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        startupFiles: [file],
        startupLinks: ["https://example.com/context"],
      })
    )
  );
});

it("accepts pasted and dropped files and reports the shared file limit", () => {
  renderDialog();
  const pasted = new File(["pasted"], "pasted.txt", { type: "text/plain" });
  fireEvent.paste(screen.getByLabelText("Title"), {
    clipboardData: {
      files: [pasted],
      items: [{ kind: "file", getAsFile: () => pasted }],
      getData: () => "",
    },
  });
  expect(
    screen.getByRole("button", { name: "Remove pasted.txt" })
  ).toBeTruthy();
  const files = Array.from(
    { length: 10 },
    (_, index) =>
      new File([String(index)], `dropped-${index}.txt`, { type: "text/plain" })
  );
  fireEvent.drop(screen.getByTestId("task-create-dialog"), {
    dataTransfer: { files },
  });
  expect(screen.getAllByTestId("context-file-item")).toHaveLength(10);
  expect(screen.getByRole("alert").textContent).toContain("maximum of 10");
  fireEvent.click(screen.getByRole("button", { name: "Remove pasted.txt" }));
  expect(screen.queryByRole("alert")).toBeNull();
});
