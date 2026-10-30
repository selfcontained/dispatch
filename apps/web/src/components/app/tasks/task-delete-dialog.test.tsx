// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { TaskDeleteDialog } from "./task-delete-dialog";
import { useHotkey } from "@/lib/hotkeys/use-hotkey";

function GlobalHotkey({ handler }: { handler: () => void }) {
  useHotkey("open-command-palette", handler);
  return null;
}

const task = {
  id: "task-1",
  projectId: "project-1",
  title: "Delete this task",
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function setup(nested = false) {
  const close = vi.fn();
  const globalHotkey = vi.fn();
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetch);
  const view = (selected = task) => (
    <QueryClientProvider client={client}>
      <GlobalHotkey handler={globalHotkey} />
      {nested ? (
        <Dialog open>
          <DialogContent>
            <DialogTitle>Task detail</DialogTitle>
            <DialogDescription>Selected task</DialogDescription>
            <TaskDeleteDialog key={selected.id} task={selected} close={close} />
          </DialogContent>
        </Dialog>
      ) : (
        <TaskDeleteDialog key={selected.id} task={selected} close={close} />
      )}
    </QueryClientProvider>
  );
  return { ...render(view()), view, close, client, fetch, globalHotkey };
}
async function open() {
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await screen.findByRole("alertdialog", { name: "Delete task?" });
}

it.each([false, true])(
  "blocks real global hotkeys while open and pending (nested: %s)",
  async (nested) => {
    const { fetch, close, globalHotkey } = setup(nested);
    const shortcut = {
      key: "k",
      ...(/Mac|iPod|iPhone|iPad/.test(navigator.platform)
        ? { metaKey: true }
        : { ctrlKey: true }),
    };
    // Prove the actual capture-phase hook is active outside the portal.
    fireEvent.keyDown(document.body, shortcut);
    expect(globalHotkey).toHaveBeenCalledTimes(1);
    globalHotkey.mockClear();
    let finish!: (response: Response) => void;
    fetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        })
    );
    await open();
    fireEvent.keyDown(document.activeElement!, shortcut);
    expect(globalHotkey).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete task" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(document.activeElement).toBe(screen.getByRole("alertdialog"));
    fireEvent.keyDown(document.activeElement!, shortcut);
    expect(globalHotkey).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    await act(async () =>
      finish(
        new Response(JSON.stringify({ error: "Try again" }), { status: 409 })
      )
    );
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    fireEvent.keyDown(document.body, shortcut);
    expect(globalHotkey).toHaveBeenCalledTimes(1);
  }
);

it("focuses Cancel and restores the opener without deleting on Cancel or Escape", async () => {
  const { fetch, close } = setup();
  await open();
  const cancel = screen.getByRole("button", { name: "Cancel" });
  expect(document.activeElement).toBe(cancel);
  fireEvent.click(cancel);
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Delete" })
    )
  );
  await open();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(fetch).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
});

it("keeps the enclosing task modal open when Escape cancels deletion", async () => {
  const { fetch, close } = setup(true);
  await open();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(screen.getByRole("dialog", { name: "Task detail" })).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
});

it("captures the named task and sends one request while pending, then invalidates and closes", async () => {
  const { fetch, close, client, rerender, view } = setup();
  let resolve!: (response: Response) => void;
  fetch.mockImplementation(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      })
  );
  const invalidate = vi.spyOn(client, "invalidateQueries");
  await open();
  rerender(view({ ...task, title: "Renamed while open" }));
  expect(screen.getByRole("alertdialog").textContent).toContain(task.title);
  expect(screen.getByRole("alertdialog").textContent).not.toContain(
    "Renamed while open"
  );
  const confirm = screen.getByRole("button", {
    name: "Delete task",
  });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(fetch).toHaveBeenCalledWith(
    "/api/v1/tasks/task-1",
    expect.objectContaining({ method: "DELETE" })
  );
  expect(
    (screen.getByRole("button", { name: "Deleting…" }) as HTMLButtonElement)
      .disabled
  ).toBe(true);
  expect(
    (screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement)
      .disabled
  ).toBe(true);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.getByRole("alertdialog")).toBeTruthy();
  expect(close).not.toHaveBeenCalled();
  await act(async () => resolve(new Response(null, { status: 204 })));
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["tasks"] });
});

it("shows server failures and allows retry or cancellation", async () => {
  const { fetch, close } = setup();
  fetch.mockResolvedValueOnce(
    new Response(JSON.stringify({ error: "Delivery is in flight" }), {
      status: 409,
    })
  );
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Delete task" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Delivery is in flight"
  );
  expect(close).not.toHaveBeenCalled();
  expect(
    (screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement)
      .disabled
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await open();
  expect(screen.queryByRole("alert")).toBeNull();
  fetch.mockResolvedValueOnce(
    new Response(JSON.stringify({ error: "Try again" }), { status: 409 })
  );
  fireEvent.click(screen.getByRole("button", { name: "Delete task" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Delete task" }));
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("discards an open confirmation when selection changes", async () => {
  const { fetch, close, rerender, view } = setup();
  await open();
  rerender(view({ ...task, id: "task-2", title: "Keep this task" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  await open();
  expect(screen.getByRole("alertdialog").textContent).toContain(
    "Keep this task"
  );
});

it.each([false, true])(
  "does not close a new task after a pending deletion settles (unmount: %s)",
  async (unmount) => {
    const { fetch, close, rerender, view, unmount: dispose } = setup();
    let resolve!: (response: Response) => void;
    fetch.mockImplementation(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        })
    );
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Delete task" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    if (unmount) dispose();
    else rerender(view({ ...task, id: "task-2" }));
    await act(async () => resolve(new Response(null, { status: 204 })));
    expect(close).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  }
);
