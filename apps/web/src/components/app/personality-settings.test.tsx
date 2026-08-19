// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { api as apiType } from "@/lib/api";

import { PersonalitySettings } from "./personality-settings";

// The panel talks to the server through the shared fetch wrapper and nothing
// else, so the HTTP seam is the only thing mocked — every row, form and
// optimistic toggle below is the real component.
vi.mock("@/lib/api", () => ({ api: vi.fn() }));

// Layout animations become plain elements so the row -> form swap is
// synchronous; otherwise framer-motion keeps the outgoing subtree mounted for
// an indeterminate number of frames and the assertions race it.
vi.mock("framer-motion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("framer-motion")>();
  const React = await import("react");
  const MOTION_ONLY_PROPS = new Set([
    "layout",
    "layoutId",
    "initial",
    "animate",
    "exit",
    "transition",
    "variants",
  ]);
  // Cached per tag: the proxy is read on every render, and handing React a
  // fresh component type each time would remount the whole list instead of
  // updating it — which silently detaches any element a test is holding.
  const cache = new Map<string, unknown>();
  const motion = new Proxy(
    {},
    {
      get: (_target, key) => {
        // Proxy `get` also fires for symbols (Symbol.toPrimitive, promise
        // unwrapping); handing one to createElement fails confusingly.
        if (typeof key !== "string") return undefined;
        const tag = key;
        const cached = cache.get(tag);
        if (cached) return cached;
        const component = React.forwardRef<
          HTMLElement,
          Record<string, unknown>
        >((props, ref) => {
          const domProps = Object.fromEntries(
            Object.entries(props).filter(([key]) => !MOTION_ONLY_PROPS.has(key))
          );
          return React.createElement(tag, { ...domProps, ref });
        });
        cache.set(tag, component);
        return component;
      },
    }
  );
  return {
    ...actual,
    motion,
    LayoutGroup: ({ children }: { children?: ReactNode }) => children,
  };
});

const { api } = await import("@/lib/api");
const apiMock = vi.mocked(api);

type Personality = {
  id: string;
  name: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
};

function makePersonality(
  id: string,
  name: string,
  prompt: string
): Personality {
  return {
    id,
    name,
    prompt,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const PIRATE = makePersonality("p_pirate", "Pirate", "Talk like a pirate.");
const TERSE = makePersonality("p_terse", "Terse", "Answer in one line.");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Mutable list payload — reassign it to model what a refresh should return. */
let listState: { personalities: Personality[]; activeId: string | null };
/** Per-request overrides keyed by `${METHOD} ${path}`. */
let overrides: Map<string, () => Promise<unknown>>;

function requestKeys(): string[] {
  return apiMock.mock.calls.map(
    ([path, init]) => `${(init?.method ?? "GET").toUpperCase()} ${path}`
  );
}

function callsFor(key: string): [string, RequestInit | undefined][] {
  return apiMock.mock.calls.filter(
    ([path, init]) => `${(init?.method ?? "GET").toUpperCase()} ${path}` === key
  ) as [string, RequestInit | undefined][];
}

function bodyOf(key: string, index = 0): unknown {
  const call = callsFor(key)[index];
  if (!call) throw new Error(`no request matching ${key}`);
  return JSON.parse(String(call[1]?.body));
}

function toggleFor(personality: Personality): HTMLElement {
  return screen.getByTestId(`personality-toggle-${personality.id}`);
}

async function renderPanel(): Promise<void> {
  render(<PersonalitySettings />);
  await waitFor(() => expect(apiMock).toHaveBeenCalled());
}

async function openCreateForm(): Promise<HTMLElement> {
  fireEvent.click(screen.getByTestId("personality-new"));
  return await screen.findByTestId("personality-form");
}

function typeInto(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

beforeEach(() => {
  listState = { personalities: [PIRATE, TERSE], activeId: TERSE.id };
  overrides = new Map();
  apiMock.mockReset();
  apiMock.mockImplementation((async (path: string, init?: RequestInit) => {
    const key = `${(init?.method ?? "GET").toUpperCase()} ${path}`;
    const override = overrides.get(key);
    if (override) return await override();
    if (key === "GET /api/v1/personalities") return listState;
    if (key === "POST /api/v1/personalities/active")
      return { activeId: listState.activeId };
    return {};
  }) as typeof apiType);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PersonalitySettings", () => {
  it("lists personalities and marks only the active one as pressed", async () => {
    await renderPanel();

    expect(await screen.findByText("Pirate")).toBeDefined();
    expect(screen.getByText("Answer in one line.")).toBeDefined();

    expect(toggleFor(TERSE).getAttribute("aria-pressed")).toBe("true");
    expect(toggleFor(TERSE).getAttribute("aria-label")).toBe(
      "Deactivate Terse"
    );
    expect(toggleFor(PIRATE).getAttribute("aria-pressed")).toBe("false");
    expect(toggleFor(PIRATE).getAttribute("aria-label")).toBe(
      "Activate Pirate"
    );
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("reports a failed load and drops the loading placeholder", async () => {
    overrides.set("GET /api/v1/personalities", () =>
      Promise.reject(new Error("personalities unavailable"))
    );

    await renderPanel();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("personalities unavailable");
    // `finally` must clear loading even on the error path, or the panel is
    // stuck on the placeholder with no way to add a personality.
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(screen.getByTestId("personality-list").children.length).toBe(0);
  });

  it("creates a personality with a trimmed name and refreshes the list", async () => {
    await renderPanel();
    const form = await openCreateForm();

    expect(screen.getByLabelText("Name")).toBe(document.activeElement);
    expect(within(form).getByTestId("personality-save").textContent).toBe(
      "Create"
    );
    expect(within(form).getByText("0 / 1000")).toBeDefined();
    // Both caps reach the DOM. jsdom does not enforce maxlength, so this is an
    // attribute check only — it does not prove the client stays in step with
    // NAME_MAX/PROMPT_MAX in apps/server/src/routes/personalities.ts.
    expect(screen.getByLabelText("Name").getAttribute("maxlength")).toBe("80");
    expect(screen.getByLabelText("Prompt").getAttribute("maxlength")).toBe(
      "1000"
    );
    // The create form replaces the button that opened it.
    expect(screen.queryByTestId("personality-new")).toBeNull();

    typeInto("Name", "  Shanty  ");
    typeInto("Prompt", "Sing it.");
    expect(within(form).getByText("8 / 1000")).toBeDefined();

    const created = makePersonality("p_shanty", "Shanty", "Sing it.");
    listState = { personalities: [PIRATE, TERSE, created], activeId: TERSE.id };
    fireEvent.click(screen.getByTestId("personality-save"));

    await waitFor(() => expect(screen.getByText("Shanty")).toBeDefined());
    expect(bodyOf("POST /api/v1/personalities")).toEqual({
      name: "Shanty",
      prompt: "Sing it.",
    });
    // The refresh is what makes the new row appear, so the list GET must run
    // again after the write.
    expect(requestKeys()).toEqual([
      "GET /api/v1/personalities",
      "POST /api/v1/personalities",
      "GET /api/v1/personalities",
    ]);
    expect(screen.queryByTestId("personality-form")).toBeNull();
  });

  it("locks the form while a save is in flight so it cannot double-post", async () => {
    const pending = deferred<{ personality: Personality }>();
    overrides.set("POST /api/v1/personalities", () => pending.promise);
    await renderPanel();
    await openCreateForm();

    typeInto("Name", "Shanty");
    typeInto("Prompt", "Sing it.");
    fireEvent.click(screen.getByTestId("personality-save"));

    await waitFor(() =>
      expect(
        (screen.getByTestId("personality-save") as HTMLButtonElement).disabled
      ).toBe(true)
    );
    expect(
      (screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    // The fields lock too — the payload was captured at click time, so edits
    // made during the request would be silently discarded.
    expect((screen.getByLabelText("Name") as HTMLInputElement).disabled).toBe(
      true
    );
    expect(
      (screen.getByLabelText("Prompt") as HTMLTextAreaElement).disabled
    ).toBe(true);

    // A second click while the first request is open would create a duplicate
    // personality, so the disabled state has to actually block it.
    fireEvent.click(screen.getByTestId("personality-save"));
    expect(callsFor("POST /api/v1/personalities")).toHaveLength(1);

    const created = makePersonality("p_shanty", "Shanty", "Sing it.");
    listState = { personalities: [PIRATE, TERSE, created], activeId: TERSE.id };
    pending.resolve({ personality: created });

    await waitFor(() => expect(screen.getByText("Shanty")).toBeDefined());
    expect(callsFor("POST /api/v1/personalities")).toHaveLength(1);
  });

  it("blocks a blank name or a whitespace-only prompt before any write", async () => {
    await renderPanel();
    await openCreateForm();

    // Each step has to CHANGE the banner text. Asserting the same message
    // twice in a row cannot distinguish "reported again" from "did nothing".
    typeInto("Prompt", "Sing it.");
    fireEvent.click(screen.getByTestId("personality-save"));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Name is required."
    );

    typeInto("Name", "Shanty");
    typeInto("Prompt", "   \n  ");
    fireEvent.click(screen.getByTestId("personality-save"));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Prompt is required."
    );

    // A name that is only whitespace is still blank once trimmed, and has to
    // say so rather than silently refusing to submit.
    typeInto("Name", "   ");
    fireEvent.click(screen.getByTestId("personality-save"));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Name is required."
    );

    expect(screen.getByTestId("personality-form")).toBeDefined();
    expect(callsFor("POST /api/v1/personalities")).toHaveLength(0);
  });

  it("clears a stale error once the save goes through", async () => {
    await renderPanel();
    await openCreateForm();

    fireEvent.click(screen.getByTestId("personality-save"));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Name is required."
    );

    typeInto("Name", "Shanty");
    typeInto("Prompt", "Sing it.");
    const created = makePersonality("p_shanty", "Shanty", "Sing it.");
    listState = { personalities: [PIRATE, TERSE, created], activeId: TERSE.id };
    fireEvent.click(screen.getByTestId("personality-save"));

    // Leaving the banner up after a successful write tells the user the save
    // failed when it did not.
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByText("Shanty")).toBeDefined();
  });

  it("drops the error banner before the post-save refresh comes back", async () => {
    const slowRefresh = deferred<never>();
    await renderPanel();
    await openCreateForm();

    fireEvent.click(screen.getByTestId("personality-save"));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Name is required."
    );

    typeInto("Name", "Shanty");
    typeInto("Prompt", "Sing it.");
    // The refresh never lands, so only the clear inside submitForm can take
    // the banner down — otherwise it lingers over a save that already worked.
    overrides.set("GET /api/v1/personalities", () => slowRefresh.promise);
    fireEvent.click(screen.getByTestId("personality-save"));

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.queryByTestId("personality-form")).toBeNull();
  });

  it("drops an error from an earlier action once any refresh succeeds", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    overrides.set("POST /api/v1/personalities/active", () =>
      Promise.reject(new Error("active personality is locked"))
    );
    await renderPanel();

    await screen.findByText("Pirate");
    fireEvent.click(toggleFor(PIRATE));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "active personality is locked"
    );

    // A later, unrelated success has to clear the stale banner — nothing on
    // the delete path touches the error state itself.
    const row = screen.getByTestId(`personality-row-${TERSE.id}`);
    listState = { personalities: [PIRATE], activeId: null };
    fireEvent.click(within(row).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.queryByText("Terse")).toBeNull();
  });

  it("edits in place and patches the personality by id", async () => {
    await renderPanel();

    const row = await screen.findByTestId(`personality-row-${TERSE.id}`);
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));

    // The form replaces that row rather than opening a second card, so the
    // other personality keeps rendering as a row.
    const form = within(row).getByTestId("personality-form");
    expect(screen.getAllByTestId("personality-form")).toHaveLength(1);
    expect(screen.getByText("Pirate")).toBeDefined();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Terse"
    );
    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe(
      "Answer in one line."
    );
    expect(within(form).getByTestId("personality-save").textContent).toBe(
      "Save"
    );

    typeInto("Name", "Tersest");
    listState = {
      personalities: [
        PIRATE,
        { ...TERSE, name: "Tersest", prompt: "Answer in one line." },
      ],
      activeId: TERSE.id,
    };
    fireEvent.click(within(form).getByTestId("personality-save"));

    await waitFor(() => expect(screen.getByText("Tersest")).toBeDefined());
    expect(bodyOf(`PATCH /api/v1/personalities/${TERSE.id}`)).toEqual({
      name: "Tersest",
      prompt: "Answer in one line.",
    });
    expect(callsFor("POST /api/v1/personalities")).toHaveLength(0);
  });

  it("keeps the form open and re-enables saving when the write fails", async () => {
    overrides.set(`PATCH /api/v1/personalities/${PIRATE.id}`, () =>
      Promise.reject(new Error("Name already taken"))
    );
    await renderPanel();

    const row = await screen.findByTestId(`personality-row-${PIRATE.id}`);
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    typeInto("Name", "Pirate 2");
    typeInto("Prompt", "Talk like a pirate, briefly.");
    fireEvent.click(screen.getByTestId("personality-save"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Name already taken");
    // The rejected edits must survive so the user can correct and retry, and
    // the buttons must come back out of the submitting state.
    expect(screen.getByTestId("personality-form")).toBeDefined();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Pirate 2"
    );
    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe(
      "Talk like a pirate, briefly."
    );
    await waitFor(() =>
      expect(
        (screen.getByTestId("personality-save") as HTMLButtonElement).disabled
      ).toBe(false)
    );
    expect(
      (screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement)
        .disabled
    ).toBe(false);
    expect(requestKeys()).toEqual([
      "GET /api/v1/personalities",
      `PATCH /api/v1/personalities/${PIRATE.id}`,
    ]);
  });

  it("cancels out of the form and clears the pending error", async () => {
    await renderPanel();
    await openCreateForm();

    fireEvent.click(screen.getByTestId("personality-save"));
    expect(await screen.findByRole("alert")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByTestId("personality-form")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("personality-new")).toBeDefined();
  });

  it("moves focus to the name field again when switching which row is edited", async () => {
    await renderPanel();

    const pirateRow = await screen.findByTestId(`personality-row-${PIRATE.id}`);
    fireEvent.click(within(pirateRow).getByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Name")).toBe(document.activeElement);

    (document.activeElement as HTMLElement).blur();
    expect(screen.getByLabelText("Name")).not.toBe(document.activeElement);

    const terseRow = screen.getByTestId(`personality-row-${TERSE.id}`);
    fireEvent.click(within(terseRow).getByRole("button", { name: "Edit" }));

    // The focus effect keys off the form session, so switching between two
    // open-form states has to re-focus rather than treat the form as unchanged.
    expect(screen.getByLabelText("Name")).toBe(document.activeElement);
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Terse"
    );
  });

  it("marks the row active before the request settles and posts its id", async () => {
    const pending = deferred<{ activeId: string | null }>();
    overrides.set("POST /api/v1/personalities/active", () => pending.promise);
    await renderPanel();

    await screen.findByText("Pirate");
    fireEvent.click(toggleFor(PIRATE));

    // Optimistic: the radio flips without waiting for the server.
    await waitFor(() =>
      expect(toggleFor(PIRATE).getAttribute("aria-pressed")).toBe("true")
    );
    expect(toggleFor(TERSE).getAttribute("aria-pressed")).toBe("false");
    expect(bodyOf("POST /api/v1/personalities/active")).toEqual({
      id: PIRATE.id,
    });

    pending.resolve({ activeId: PIRATE.id });
    await waitFor(() =>
      expect(toggleFor(PIRATE).getAttribute("aria-pressed")).toBe("true")
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("clears the active personality when the active row is toggled off", async () => {
    await renderPanel();

    await screen.findByText("Terse");
    fireEvent.click(toggleFor(TERSE));

    await waitFor(() =>
      expect(toggleFor(TERSE).getAttribute("aria-pressed")).toBe("false")
    );
    expect(bodyOf("POST /api/v1/personalities/active")).toEqual({ id: null });
  });

  it("restores the previous active row when the toggle request fails", async () => {
    overrides.set("POST /api/v1/personalities/active", () =>
      Promise.reject(new Error("active personality is locked"))
    );
    await renderPanel();

    await screen.findByText("Pirate");
    fireEvent.click(toggleFor(PIRATE));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("active personality is locked");
    expect(toggleFor(PIRATE).getAttribute("aria-pressed")).toBe("false");
    expect(toggleFor(TERSE).getAttribute("aria-pressed")).toBe("true");
  });

  it("does not delete when the confirmation is dismissed", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    await renderPanel();

    const row = await screen.findByTestId(`personality-row-${PIRATE.id}`);
    fireEvent.click(within(row).getByRole("button", { name: "Delete" }));

    expect(confirmSpy).toHaveBeenCalledWith(
      'Delete personality "Pirate"? This cannot be undone.'
    );
    expect(requestKeys()).toEqual(["GET /api/v1/personalities"]);
    expect(screen.getByText("Pirate")).toBeDefined();
  });

  it("deletes the confirmed personality and refreshes the list", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await renderPanel();

    const row = await screen.findByTestId(`personality-row-${PIRATE.id}`);
    listState = { personalities: [TERSE], activeId: TERSE.id };
    fireEvent.click(within(row).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.queryByText("Pirate")).toBeNull());
    expect(requestKeys()).toEqual([
      "GET /api/v1/personalities",
      `DELETE /api/v1/personalities/${PIRATE.id}`,
      "GET /api/v1/personalities",
    ]);
    expect(screen.getByText("Terse")).toBeDefined();
  });

  it("surfaces a delete failure without dropping the row", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    overrides.set(`DELETE /api/v1/personalities/${PIRATE.id}`, () =>
      Promise.reject(new Error("personality is in use"))
    );
    await renderPanel();

    const row = await screen.findByTestId(`personality-row-${PIRATE.id}`);
    fireEvent.click(within(row).getByRole("button", { name: "Delete" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "personality is in use"
    );
    expect(screen.getByText("Pirate")).toBeDefined();
    expect(callsFor("GET /api/v1/personalities")).toHaveLength(1);
  });
});
