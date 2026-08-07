// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { QuickPhrase } from "@/hooks/use-quick-phrases";
import type { TemplateArg } from "@/hooks/use-templates";

import { QuickPhrasesButton } from "./quick-phrases-button";

// The picker renders its real children (PhraseRow, InjectSplitButton, the
// edit and fill dialogs) and the real useQuickPhrases/useQuickPhraseActions
// react-query hooks; only the HTTP seam and toast sink are mocked. That pins
// the whole contract from cmdk selection down to the wire payload — a stubbed
// actions object could silently diverge on args/submit shape.
vi.mock("@/lib/api", () => ({ api: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const { api } = await import("@/lib/api");
const { toast } = await import("sonner");
const apiMock = vi.mocked(api);
const toastErrorMock = vi.mocked(toast.error);

function makeArg(overrides: Partial<TemplateArg> = {}): TemplateArg {
  return {
    name: "Name",
    key: "name",
    placeholder: "{{D:Name|required}}",
    required: true,
    multiline: false,
    ...overrides,
  };
}

function makePhrase(overrides: Partial<QuickPhrase> = {}): QuickPhrase {
  return {
    id: "qp_1",
    label: "Deploy",
    text: "run the deploy checklist",
    args: [],
    sortOrder: 0,
    createdAt: "2026-08-01T12:00:00.000Z",
    ...overrides,
  };
}

const TWO_PHRASES: QuickPhrase[] = [
  makePhrase(),
  makePhrase({
    id: "qp_2",
    label: null,
    text: "summarize recent commits",
    sortOrder: 1,
  }),
];

// Serves the phrases list for the query (and its post-invalidation refetches)
// while leaving every mutation call to per-test mockImplementation/queueing.
function serveGet(phrases: QuickPhrase[]): void {
  apiMock.mockImplementation((path: string, init?: RequestInit) => {
    if (path === "/api/v1/quick-phrases" && !init) {
      return Promise.resolve({ phrases });
    }
    return Promise.resolve(null);
  });
}

function renderPicker(agentId: string | null = "agt_1") {
  const focusTerminal = vi.fn();
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <QuickPhrasesButton agentId={agentId} focusTerminal={focusTerminal} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { focusTerminal };
}

async function openPicker(): Promise<HTMLInputElement> {
  fireEvent.click(screen.getByTestId("quick-phrases-button"));
  return (await screen.findByPlaceholderText(
    "Search phrases..."
  )) as HTMLInputElement;
}

function injectCalls(): Array<Record<string, unknown>> {
  return apiMock.mock.calls
    .filter(([path]) => String(path).endsWith("/terminal/inject-phrase"))
    .map(
      ([, init]) =>
        JSON.parse((init as { body: string }).body) as Record<string, unknown>
    );
}

function listGetCount(): number {
  return apiMock.mock.calls.filter(
    ([path, init]) => path === "/api/v1/quick-phrases" && !init
  ).length;
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  apiMock.mockReset();
  toastErrorMock.mockReset();
  // cmdk scrolls the selected option into view and observes the list's size;
  // jsdom provides neither API.
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

afterEach(() => {
  cleanup();
  // Restores the window.confirm spy even when its test fails mid-body.
  vi.restoreAllMocks();
});

describe("list rendering and search", () => {
  it("fetches phrases and renders label, falling back to text", async () => {
    serveGet(TWO_PHRASES);
    renderPicker();
    await openPicker();

    expect(await screen.findByText("Deploy")).toBeTruthy();
    expect(screen.getByText("summarize recent commits")).toBeTruthy();
    expect(apiMock).toHaveBeenCalledWith("/api/v1/quick-phrases");
  });

  it("shows the empty state when there are no phrases", async () => {
    serveGet([]);
    renderPicker();
    await openPicker();

    expect(await screen.findByText("No phrases yet")).toBeTruthy();
  });

  it("filters case-insensitively across both label and text", async () => {
    serveGet(TWO_PHRASES);
    renderPicker();
    const input = await openPicker();
    await screen.findByText("Deploy");

    // Matches qp_1 only via its label.
    fireEvent.change(input, { target: { value: "DEPLOY" } });
    expect(screen.getByText("Deploy")).toBeTruthy();
    expect(screen.queryByText("summarize recent commits")).toBeNull();

    // Matches qp_1 only via its text.
    fireEvent.change(input, { target: { value: "checklist" } });
    expect(screen.getByText("Deploy")).toBeTruthy();
    expect(screen.queryByText("summarize recent commits")).toBeNull();

    // Whitespace-only query is treated as empty: everything shows.
    fireEvent.change(input, { target: { value: "   " } });
    expect(screen.getByText("Deploy")).toBeTruthy();
    expect(screen.getByText("summarize recent commits")).toBeTruthy();
  });

  it("shows the no-match row for a query that matches nothing", async () => {
    serveGet(TWO_PHRASES);
    renderPicker();
    const input = await openPicker();
    await screen.findByText("Deploy");

    fireEvent.change(input, { target: { value: "zzz-no-match" } });
    expect(screen.getByText("No matching phrases")).toBeTruthy();
    expect(screen.queryByText("Deploy")).toBeNull();
  });

  it("clears the previous search when the picker reopens", async () => {
    serveGet(TWO_PHRASES);
    renderPicker();
    let input = await openPicker();
    await screen.findByText("Deploy");
    fireEvent.change(input, { target: { value: "checklist" } });
    expect(screen.queryByText("summarize recent commits")).toBeNull();

    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByPlaceholderText("Search phrases...")).toBeNull()
    );

    input = await openPicker();
    expect(input.value).toBe("");
    expect(await screen.findByText("summarize recent commits")).toBeTruthy();
  });
});

describe("inject wire payloads", () => {
  it("selecting a no-arg phrase injects it with submit, then closes and focuses the terminal", async () => {
    serveGet(TWO_PHRASES);
    const { focusTerminal } = renderPicker();
    await openPicker();
    await screen.findByText("Deploy");

    fireEvent.click(screen.getByText("Deploy"));

    await waitFor(() => expect(injectCalls()).toHaveLength(1));
    const [path, init] = apiMock.mock.calls.find(([p]) =>
      String(p).endsWith("/terminal/inject-phrase")
    )!;
    expect(path).toBe("/api/v1/agents/agt_1/terminal/inject-phrase");
    expect((init as { method: string }).method).toBe("POST");
    expect(injectCalls()[0]).toEqual({ phraseId: "qp_1", submit: true });

    await waitFor(() =>
      expect(screen.queryByPlaceholderText("Search phrases...")).toBeNull()
    );
    expect(focusTerminal).toHaveBeenCalledTimes(1);
  });

  it("ArrowDown + Enter selects the second phrase via the keyboard", async () => {
    serveGet(TWO_PHRASES);
    renderPicker();
    const input = await openPicker();
    await screen.findByText("Deploy");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(injectCalls()).toHaveLength(1));
    expect(injectCalls()[0]).toEqual({ phraseId: "qp_2", submit: true });
  });

  it("keyboard selection follows the filtered list, not the full list", async () => {
    serveGet(TWO_PHRASES);
    renderPicker();
    const input = await openPicker();
    await screen.findByText("Deploy");

    // Filter down to only the second phrase; plain Enter must select it —
    // an index into the unfiltered array would inject qp_1 instead.
    fireEvent.change(input, { target: { value: "summarize" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(injectCalls()).toHaveLength(1));
    expect(injectCalls()[0]).toEqual({ phraseId: "qp_2", submit: true });
  });

  it("the row Send button injects exactly once — the click must not bubble into onSelect", async () => {
    serveGet(TWO_PHRASES);
    renderPicker();
    await openPicker();
    await screen.findByText("Deploy");

    const sendButtons = screen.getAllByRole("button", { name: /Send/ });
    fireEvent.click(sendButtons[0]);

    await waitFor(() => expect(injectCalls()).toHaveLength(1));
    expect(injectCalls()[0]).toEqual({ phraseId: "qp_1", submit: true });
    // A removed stopPropagation in PhraseRow fires both the button handler and
    // the CommandItem's onSelect in the same dispatch (before isPending
    // re-renders), yielding a second call — so re-check after settling.
    await flushMicrotasks();
    expect(injectCalls()).toHaveLength(1);
  });

  it("'Paste without submitting' injects with submit=false", async () => {
    serveGet(TWO_PHRASES);
    renderPicker();
    await openPicker();
    const row = (await screen.findByText("Deploy")).closest(
      "[cmdk-item]"
    ) as HTMLElement;

    // Radix's DropdownMenu.Trigger guarantees aria-haspopup="menu" as part of
    // its ARIA contract, and it is the only such button in the row.
    const trigger = row.querySelector('button[aria-haspopup="menu"]');
    expect(trigger).toBeTruthy();
    fireEvent.pointerDown(trigger!);
    fireEvent.click(trigger!);

    const paste = await screen.findByText("Paste without submitting");
    fireEvent.click(paste);

    await waitFor(() => expect(injectCalls()).toHaveLength(1));
    expect(injectCalls()[0]).toEqual({ phraseId: "qp_1", submit: false });
  });

  it("suppresses a second inject while the first is still pending", async () => {
    let resolveInject: (value: unknown) => void = () => {};
    apiMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/api/v1/quick-phrases" && !init) {
        return Promise.resolve({ phrases: TWO_PHRASES });
      }
      return new Promise((resolve) => {
        resolveInject = resolve;
      });
    });
    renderPicker();
    await openPicker();
    await screen.findByText("Deploy");

    fireEvent.click(screen.getByText("Deploy"));
    await waitFor(() => expect(injectCalls()).toHaveLength(1));
    fireEvent.click(screen.getByText("Deploy"));

    await act(async () => {
      resolveInject(null);
      await Promise.resolve();
    });
    // Assert AFTER the first mutation settles — a sync assertion passes even
    // when the pending guard is deleted.
    expect(injectCalls()).toHaveLength(1);
  });

  it("shows an error toast and keeps the picker open when inject fails", async () => {
    apiMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/api/v1/quick-phrases" && !init) {
        return Promise.resolve({ phrases: TWO_PHRASES });
      }
      return Promise.reject(new Error("boom"));
    });
    const { focusTerminal } = renderPicker();
    await openPicker();
    await screen.findByText("Deploy");

    fireEvent.click(screen.getByText("Deploy"));

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith("Failed to send phrase")
    );
    expect(screen.getByPlaceholderText("Search phrases...")).toBeTruthy();
    expect(focusTerminal).not.toHaveBeenCalled();
  });
});

describe("disconnected state", () => {
  it("shows the banner, hides Send controls, and never injects without an agent", async () => {
    serveGet(TWO_PHRASES);
    renderPicker(null);
    await openPicker();
    await screen.findByText("Deploy");

    expect(
      screen.getByText("Connect to an agent session to inject phrases")
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Send/ })).toBeNull();

    fireEvent.click(screen.getByText("Deploy"));
    await flushMicrotasks();
    expect(injectCalls()).toHaveLength(0);
  });

  it("does not open the fill dialog for an args phrase without an agent", async () => {
    serveGet([makePhrase({ args: [makeArg()] })]);
    renderPicker(null);
    await openPicker();
    await screen.findByText("Deploy");

    fireEvent.click(screen.getByText("Deploy"));
    await flushMicrotasks();
    expect(
      screen.queryByText("Fill in the variables below, then inject the phrase.")
    ).toBeNull();
  });
});

describe("fill variables flow", () => {
  const ARGS_PHRASE = makePhrase({
    label: "Greet",
    text: "Say hi to {{D:Name|required}}",
    args: [makeArg()],
  });

  it("selecting an args phrase opens the fill dialog instead of injecting", async () => {
    serveGet([ARGS_PHRASE]);
    renderPicker();
    await openPicker();
    await screen.findByText("Greet");

    fireEvent.click(screen.getByText("Greet"));

    // Dialog title is the phrase label.
    expect(await screen.findByRole("heading", { name: "Greet" })).toBeTruthy();
    expect(injectCalls()).toHaveLength(0);
  });

  it("blocks submit while a required value is missing or whitespace-only", async () => {
    serveGet([ARGS_PHRASE]);
    renderPicker();
    await openPicker();
    await screen.findByText("Greet");
    fireEvent.click(screen.getByText("Greet"));
    await screen.findByRole("heading", { name: "Greet" });

    const form = document.querySelector("form") as HTMLFormElement;
    fireEvent.submit(form);
    await flushMicrotasks();
    expect(injectCalls()).toHaveLength(0);

    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: "   " },
    });
    fireEvent.submit(form);
    await flushMicrotasks();
    expect(injectCalls()).toHaveLength(0);
    expect(
      (
        screen.getByRole("button", {
          name: "Send & Submit",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
  });

  it("submits filled args with submit=true and closes everything on success", async () => {
    serveGet([ARGS_PHRASE]);
    const { focusTerminal } = renderPicker();
    await openPicker();
    await screen.findByText("Greet");
    fireEvent.click(screen.getByText("Greet"));
    await screen.findByRole("heading", { name: "Greet" });

    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: "Ada" },
    });
    fireEvent.submit(document.querySelector("form") as HTMLFormElement);

    await waitFor(() => expect(injectCalls()).toHaveLength(1));
    expect(injectCalls()[0]).toEqual({
      phraseId: "qp_1",
      args: { name: "Ada" },
      submit: true,
    });
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Greet" })).toBeNull()
    );
    expect(focusTerminal).toHaveBeenCalledTimes(1);
  });
});

describe("create, edit, and delete", () => {
  it("creates a phrase, omitting an empty label, and refetches the list", async () => {
    serveGet([]);
    renderPicker();
    await openPicker();
    const initialGets = listGetCount();

    fireEvent.click(screen.getByTitle("Add phrase"));
    await screen.findByRole("heading", { name: "Add Phrase" });

    fireEvent.change(screen.getByLabelText("Phrase text"), {
      target: { value: "  new phrase text  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Add Phrase" })).toBeNull()
    );
    const create = apiMock.mock.calls.find(
      ([path, init]) =>
        path === "/api/v1/quick-phrases" &&
        (init as { method?: string } | undefined)?.method === "POST"
    );
    expect(create).toBeTruthy();
    const body = JSON.parse((create![1] as { body: string }).body) as Record<
      string,
      unknown
    >;
    expect(body).toEqual({ text: "new phrase text" });
    // onSuccess invalidates the active list query.
    await waitFor(() => expect(listGetCount()).toBeGreaterThan(initialGets));
  });

  it("trims and sends a provided label on create", async () => {
    serveGet([]);
    renderPicker();
    await openPicker();

    fireEvent.click(screen.getByTitle("Add phrase"));
    await screen.findByRole("heading", { name: "Add Phrase" });
    fireEvent.change(screen.getByLabelText("Label (optional)"), {
      target: { value: "  My Label  " },
    });
    fireEvent.change(screen.getByLabelText("Phrase text"), {
      target: { value: "text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Add Phrase" })).toBeNull()
    );
    const create = apiMock.mock.calls.find(
      ([path, init]) =>
        path === "/api/v1/quick-phrases" &&
        (init as { method?: string } | undefined)?.method === "POST"
    );
    expect(JSON.parse((create![1] as { body: string }).body)).toEqual({
      label: "My Label",
      text: "text",
    });
  });

  it("disables Save while the text is blank", async () => {
    serveGet([]);
    renderPicker();
    await openPicker();
    fireEvent.click(screen.getByTitle("Add phrase"));
    await screen.findByRole("heading", { name: "Add Phrase" });

    const save = screen.getByRole("button", {
      name: "Save",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Phrase text"), {
      target: { value: "   " },
    });
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Phrase text"), {
      target: { value: "x" },
    });
    expect(save.disabled).toBe(false);
  });

  it("shows detected variable chips with required and multiline markers", async () => {
    serveGet([]);
    renderPicker();
    await openPicker();
    fireEvent.click(screen.getByTitle("Add phrase"));
    await screen.findByRole("heading", { name: "Add Phrase" });

    fireEvent.change(screen.getByLabelText("Phrase text"), {
      target: { value: "Hi {{D:Name|required}} — {{D:Notes|multiline}}" },
    });

    expect(screen.getByText("Name *")).toBeTruthy();
    expect(screen.getByText("Notes (multiline)")).toBeTruthy();
  });

  it("editing an existing phrase sends PATCH with a cleared label as null", async () => {
    serveGet(TWO_PHRASES);
    renderPicker();
    await openPicker();
    await screen.findByText("Deploy");

    fireEvent.click(screen.getAllByTitle("Edit phrase")[0]);
    await screen.findByRole("heading", { name: "Edit Phrase" });
    expect(
      (screen.getByLabelText("Label (optional)") as HTMLInputElement).value
    ).toBe("Deploy");
    expect(
      (screen.getByLabelText("Phrase text") as HTMLTextAreaElement).value
    ).toBe("run the deploy checklist");

    fireEvent.change(screen.getByLabelText("Label (optional)"), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Edit Phrase" })).toBeNull()
    );
    const patch = apiMock.mock.calls.find(
      ([path]) => path === "/api/v1/quick-phrases/qp_1"
    );
    expect((patch![1] as { method: string }).method).toBe("PATCH");
    expect(JSON.parse((patch![1] as { body: string }).body)).toEqual({
      label: null,
      text: "run the deploy checklist",
    });
  });

  it("deletes only after the confirm dialog is accepted", async () => {
    serveGet(TWO_PHRASES);
    renderPicker();
    await openPicker();
    await screen.findByText("Deploy");

    const confirmSpy = vi
      .spyOn(window, "confirm")
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    const deleteButton = screen.getAllByTitle("Delete phrase")[0];
    fireEvent.click(deleteButton);
    await flushMicrotasks();
    expect(
      apiMock.mock.calls.some(([path]) => path === "/api/v1/quick-phrases/qp_1")
    ).toBe(false);

    fireEvent.click(deleteButton);
    await waitFor(() =>
      expect(
        apiMock.mock.calls.some(
          ([path, init]) =>
            path === "/api/v1/quick-phrases/qp_1" &&
            (init as { method?: string } | undefined)?.method === "DELETE"
        )
      ).toBe(true)
    );
    expect(confirmSpy.mock.calls[0][0]).toContain("Deploy");
  });
});
