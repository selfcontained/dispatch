// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";

import { Alert } from "./alert";
import { AsyncBoundary, type AsyncResult } from "./async-boundary";
import {
  Combobox,
  ComboboxContent,
  ComboboxItem,
  ComboboxTrigger,
} from "./combobox";
import { ConfirmDialog } from "./confirm-dialog";
import {
  Dialog,
  DialogBody,
  DialogCancel,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./dialog";
import { Field } from "./field";
import { Input } from "./input";
import { SettingRow } from "./setting-row";
import { Switch } from "./switch";

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(cleanup);

describe("ConfirmDialog", () => {
  it("keeps a failure inline and lets the same button retry", async () => {
    const run = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new ApiError(500, "database is down"))
      .mockResolvedValue(undefined);
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Pause…</button>
          <ConfirmDialog
            open={open}
            onOpenChange={setOpen}
            title="Pause “worker”?"
            confirmLabel="Pause agent"
            errorTitle="Couldn’t pause the agent."
            onConfirm={run}
          />
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Pause…" });
    opener.focus();
    fireEvent.click(opener);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Cancel" })
      )
    );

    const confirm = screen.getByRole("button", { name: "Pause agent" });
    fireEvent.click(confirm);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn’t pause the agent.");
    expect(alert.textContent).toContain("Try again in a moment.");
    expect(
      within(alert).getByText("database is down").closest("details")
    ).not.toBeNull();
    expect(document.activeElement).toBe(confirm);

    fireEvent.click(confirm);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(run).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("stays open, focused on Cancel, when the answer is another question", async () => {
    const close = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={close}
        title="Archive?"
        confirmLabel="Archive"
        errorTitle="Couldn’t archive."
        onConfirm={() => false}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Cancel" })
      )
    );
    expect(close).not.toHaveBeenCalled();
  });
});

describe("DialogContent", () => {
  function Sample({
    busy,
    onOpenChange,
  }: {
    busy?: boolean;
    onOpenChange: (open: boolean) => void;
  }) {
    return (
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent busy={busy} aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>New thing</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <input aria-label="First field" />
          </DialogBody>
          <DialogFooter>
            <DialogCancel />
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  it("focuses the content, not the close button, and closes from Close", async () => {
    const close = vi.fn();
    render(<Sample onOpenChange={close} />);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText("First field"))
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(close).toHaveBeenCalledWith(false);
  });

  it("holds every way out while busy", async () => {
    const close = vi.fn();
    render(<Sample busy onOpenChange={close} />);
    for (const name of ["Close", "Cancel"]) {
      const button = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
    }
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
  });

  it("leaves Escape to an open suggestion list in the body", () => {
    const close = vi.fn();
    const view = (expanded: boolean) => (
      <Dialog open onOpenChange={close}>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>New agent</DialogTitle>
          <input role="combobox" aria-expanded={expanded} aria-label="Folder" />
        </DialogContent>
      </Dialog>
    );
    const { rerender } = render(view(true));
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
    rerender(view(false));
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(close).toHaveBeenCalledWith(false);
  });
});

describe("Combobox", () => {
  function Branches({ pick }: { pick: (value: string) => void }) {
    const [open, setOpen] = useState(true);
    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>New agent</DialogTitle>
          <Combobox>
            <ComboboxTrigger aria-label="Branch">main</ComboboxTrigger>
            <ComboboxContent label="Search branches" value="main">
              {["main", "develop", "release"].map((branch) => (
                <ComboboxItem
                  key={branch}
                  value={branch}
                  selected={branch === "main"}
                  onSelect={() => pick(branch)}
                >
                  {branch}
                </ComboboxItem>
              ))}
            </ComboboxContent>
          </Combobox>
        </DialogContent>
      </Dialog>
    );
  }
  const highlighted = () =>
    screen
      .getAllByRole("option")
      .find((option) => option.getAttribute("aria-selected") === "true")
      ?.textContent;

  it("moves with the arrows, picks with Enter and returns focus", async () => {
    const pick = vi.fn();
    render(<Branches pick={pick} />);
    const trigger = screen.getByRole("combobox", { name: "Branch" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const search = await screen.findByPlaceholderText("Search…");
    await waitFor(() => expect(document.activeElement).toBe(search));
    expect(highlighted()).toBe("main");
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(highlighted()).toBe("develop");
    fireEvent.keyDown(search, { key: "Enter" });
    expect(pick).toHaveBeenCalledWith("develop");
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("starts searching with the key typed on the closed trigger", async () => {
    const pick = vi.fn();
    render(<Branches pick={pick} />);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Branch" }), {
      key: "r",
    });
    const search = (await screen.findByPlaceholderText(
      "Search…"
    )) as HTMLInputElement;
    expect(search.value).toBe("r");
    await waitFor(() => expect(search.selectionStart).toBe(1));
    await waitFor(() => expect(highlighted()).toBe("release"));
    fireEvent.keyDown(search, { key: "Enter" });
    expect(pick).toHaveBeenCalledWith("release");
  });

  it("closes only itself on Escape inside a dialog", async () => {
    render(<Branches pick={vi.fn()} />);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Branch" }), {
      key: "ArrowDown",
    });
    const search = await screen.findByPlaceholderText("Search…");
    await waitFor(() => expect(document.activeElement).toBe(search));
    fireEvent.keyDown(search, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByPlaceholderText("Search…")).toBeNull()
    );
    expect(screen.getByRole("dialog", { name: "New agent" })).toBeTruthy();
  });
});

describe("AsyncBoundary", () => {
  const show = (query: Partial<AsyncResult<string[]>>) =>
    render(
      <AsyncBoundary
        query={{
          data: undefined,
          error: null,
          isFetching: false,
          refetch: vi.fn(),
          ...query,
        }}
        thing="jobs"
        isEmpty={(jobs) => jobs.length === 0}
        empty={<p>No jobs.</p>}
        notFound={<p>Not found.</p>}
      >
        {(jobs) => <p>{jobs.join(", ")}</p>}
      </AsyncBoundary>
    );

  it("is loading until there's an answer, never empty", () => {
    show({});
    expect(screen.getByText("Loading jobs…")).toBeTruthy();
    expect(screen.queryByText("No jobs.")).toBeNull();
  });

  it("is empty only after a success", () => {
    show({ data: [] });
    expect(screen.getByText("No jobs.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("doesn't call a failed refresh of nothing empty", () => {
    show({ data: [], error: new Error("offline") });
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByText("No jobs.")).toBeNull();
  });

  it("keeps content under a failed refresh", () => {
    show({ data: ["nightly"], error: new Error("offline") });
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("nightly")).toBeTruthy();
  });

  it("says not found for a 404 and nothing else", () => {
    show({ error: new ApiError(500, "boom") });
    expect(screen.queryByText("Not found.")).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    cleanup();
    show({ error: new ApiError(404, "gone") });
    expect(screen.getByText("Not found.")).toBeTruthy();
  });
});

it("runs each Alert action on its own", () => {
  const primary = vi.fn();
  const secondary = vi.fn();
  render(
    <Alert
      title="Signed out."
      action={{ label: "Sign in", onClick: primary }}
      secondaryAction={{ label: "Send again", onClick: secondary }}
    />
  );
  fireEvent.click(screen.getByRole("button", { name: "Send again" }));
  expect([primary.mock.calls.length, secondary.mock.calls.length]).toEqual([
    0, 1,
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(primary).toHaveBeenCalledOnce();
});

it("joins a Field's control to its label, hint and error", () => {
  render(
    <Field label="Name" hint="Shown on the board." error="Enter a name.">
      <Input />
    </Field>
  );
  const input = screen.getByRole("textbox", { name: "Name" });
  expect(input.getAttribute("aria-invalid")).toBe("true");
  const described = input
    .getAttribute("aria-describedby")!
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent);
  expect(described).toEqual(["Enter a name.", "Shown on the board."]);
});

it("names a SettingRow's control by its label and toggles from the row", () => {
  const change = vi.fn();
  render(
    <SettingRow label="Single instance" description="One run at a time.">
      <Switch onCheckedChange={change} />
    </SettingRow>
  );
  expect(screen.getByRole("switch", { name: "Single instance" })).toBeTruthy();
  act(() => {
    fireEvent.click(screen.getByText("One run at a time."));
  });
  expect(change).toHaveBeenCalledWith(true);
});
