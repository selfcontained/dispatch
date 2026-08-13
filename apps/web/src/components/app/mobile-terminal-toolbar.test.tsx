// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { soundCuesEnabledAtom } from "@/lib/store";

import { MobileTerminalToolbar } from "./mobile-terminal-toolbar";

// The toolbar is the only input surface on mobile, and nearly everything it
// does is a side effect on something outside its own markup: an escape
// sequence handed to the terminal socket, a ref the terminal's onData handler
// reads to fold in the ctrl modifier, and an inject-text POST that
// deliberately does NOT go over the terminal WS. Those contracts are invisible
// from the DOM, so the real components are mounted (including the copy-mode
// banner) and only the HTTP seam, the toaster, and the audio cue are mocked.
vi.mock("@/lib/api", () => ({ api: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/sound-cues", () => ({ playTapCue: vi.fn() }));
vi.mock("framer-motion", async (importOriginal) => {
  const { createFramerMotionMock } =
    await import("@/test-utils/framer-motion-mock");
  return createFramerMotionMock(importOriginal);
});

const { api } = await import("@/lib/api");
const { toast } = await import("sonner");
const { playTapCue } = await import("@/lib/sound-cues");
const apiMock = vi.mocked(api);
const toastError = vi.mocked(toast.error);
const playTapCueMock = vi.mocked(playTapCue);

const ESC = "\u001b";
const FRAME_MS = 16;
const PLACEHOLDER = "Type command here...";

/** Advance whole animation frames and let React commit the resulting state. */
function advanceFrames(frames = 1): void {
  act(() => {
    vi.advanceTimersByTime(FRAME_MS * frames);
  });
}

/** Flush pending microtasks (react-query mutation callbacks) inside act. */
async function flush(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

function button(label: string): HTMLButtonElement {
  return screen.getByLabelText(label) as HTMLButtonElement;
}

function ctrlButton(): HTMLButtonElement {
  return button("Toggle Control modifier");
}

function composer(): HTMLTextAreaElement | null {
  return screen.queryByPlaceholderText(
    PLACEHOLDER
  ) as HTMLTextAreaElement | null;
}

type RenderOptions = {
  agentId?: string | null;
  isConnected?: boolean;
  copyMode?: "live" | "copy" | "exiting" | "unknown";
  soundCuesEnabled?: boolean;
};

function renderToolbar(options: RenderOptions = {}) {
  const {
    agentId = "agt_1",
    isConnected = true,
    copyMode = "live",
    soundCuesEnabled = true,
  } = options;

  const onSendInput = vi.fn();
  const onExitCopyMode = vi.fn();
  const ctrlPendingRef = { current: false };

  const store = createStore();
  store.set(soundCuesEnabledAtom, soundCuesEnabled);

  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });

  const tree = (
    props: Required<Pick<RenderOptions, "isConnected">> & {
      agentId: string | null;
      copyMode: NonNullable<RenderOptions["copyMode"]>;
    }
  ) => (
    <Provider store={store}>
      <QueryClientProvider client={queryClient}>
        <MobileTerminalToolbar
          agentId={props.agentId}
          onSendInput={onSendInput}
          onExitCopyMode={onExitCopyMode}
          ctrlPendingRef={ctrlPendingRef}
          isConnected={props.isConnected}
          copyMode={props.copyMode}
        />
      </QueryClientProvider>
    </Provider>
  );

  const view = render(tree({ agentId, isConnected, copyMode }));

  const rerender = (next: RenderOptions) =>
    view.rerender(
      tree({
        agentId: next.agentId === undefined ? agentId : next.agentId,
        isConnected: next.isConnected ?? isConnected,
        copyMode: next.copyMode ?? copyMode,
      })
    );

  return { ...view, rerender, onSendInput, onExitCopyMode, ctrlPendingRef };
}

/** Open the fullscreen composer and settle both focus frames. */
function openComposer(): HTMLTextAreaElement {
  fireEvent.click(button("Open text input"));
  advanceFrames(2);
  return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
}

function typeDraft(textarea: HTMLTextAreaElement, value: string): void {
  fireEvent.change(textarea, { target: { value } });
}

const SHORTCUT_KEYS: Array<[label: string, sequence: string]> = [
  ["Send Escape", ESC],
  ["Send Tab", "\t"],
  ["Send Arrow Left", `${ESC}[D`],
  ["Send Arrow Up", `${ESC}[A`],
  ["Send Arrow Down", `${ESC}[B`],
  ["Send Arrow Right", `${ESC}[C`],
  ["Send Enter", "\r"],
];

beforeEach(() => {
  // requestAnimationFrame is not in vitest's default toFake set, but the
  // toolbar drives both the press flash and the iOS keyboard focus workaround
  // through it — leaving rAF real while setTimeout is faked would strand
  // those callbacks.
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "Date",
      "requestAnimationFrame",
      "cancelAnimationFrame",
    ],
  });
});

afterEach(() => {
  // apps/web has no globals/setupFiles, so RTL auto-cleanup never runs and a
  // surviving tree would keep its flash timer and window listener alive.
  cleanup();
  vi.useRealTimers();
  apiMock.mockReset();
  toastError.mockReset();
  playTapCueMock.mockReset();
});

describe("MobileTerminalToolbar shortcut keys", () => {
  it.each(SHORTCUT_KEYS)(
    "sends the exact escape sequence for %s",
    (label, sequence) => {
      const { onSendInput } = renderToolbar();

      fireEvent.click(button(label));

      expect(onSendInput.mock.calls).toEqual([[sequence]]);
    }
  );

  it("disables every terminal control while disconnected and sends nothing", () => {
    const { onSendInput } = renderToolbar({ isConnected: false });

    const controls = [
      ...SHORTCUT_KEYS.map(([label]) => label),
      "Toggle Control modifier",
      "Open text input",
    ];
    for (const label of controls) {
      const control = button(label);
      expect(control.disabled).toBe(true);
      fireEvent.click(control);
      fireEvent.pointerDown(control);
    }

    expect(onSendInput).not.toHaveBeenCalled();
    expect(composer()).toBeNull();
  });
});

describe("MobileTerminalToolbar ctrl modifier", () => {
  it("arms and disarms the ref the terminal reads for the next keystroke", () => {
    const { ctrlPendingRef } = renderToolbar();

    fireEvent.pointerDown(ctrlButton());
    expect(ctrlButton().getAttribute("aria-pressed")).toBe("true");
    expect(ctrlPendingRef.current).toBe(true);

    fireEvent.pointerDown(ctrlButton());
    expect(ctrlButton().getAttribute("aria-pressed")).toBe("false");
    expect(ctrlPendingRef.current).toBe(false);
  });

  it("marks the armed ctrl button as active", () => {
    renderToolbar();

    expect(ctrlButton().className).not.toContain("ring-primary");
    fireEvent.pointerDown(ctrlButton());
    expect(ctrlButton().className).toContain("ring-primary");
  });

  it("disarms ctrl after any shortcut key press without rewriting the key", () => {
    const { ctrlPendingRef, onSendInput } = renderToolbar();

    fireEvent.pointerDown(ctrlButton());
    fireEvent.click(button("Send Tab"));

    // The toolbar hands the raw key over; folding the ctrl modifier into the
    // byte is the terminal onData handler's job (hooks/terminal-surface.ts).
    expect(onSendInput.mock.calls).toEqual([["\t"]]);
    expect(ctrlPendingRef.current).toBe(false);
    expect(ctrlButton().getAttribute("aria-pressed")).toBe("false");
  });

  it("clears only the indicator when the terminal consumes the modifier", () => {
    const { ctrlPendingRef } = renderToolbar();

    fireEvent.pointerDown(ctrlButton());
    expect(ctrlButton().getAttribute("aria-pressed")).toBe("true");

    // terminal-surface.ts clears the ref itself and then announces it, so the
    // toolbar must not write the ref back — doing so would clobber a modifier
    // re-armed in the same tick.
    ctrlPendingRef.current = true;
    act(() => {
      window.dispatchEvent(new Event("ctrl-consumed"));
    });

    expect(ctrlButton().getAttribute("aria-pressed")).toBe("false");
    expect(ctrlPendingRef.current).toBe(true);
  });

  it("stops listening for ctrl-consumed once unmounted", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");

    const { unmount } = renderToolbar();
    const added = addSpy.mock.calls.find(([type]) => type === "ctrl-consumed");
    expect(added).toBeDefined();

    unmount();

    expect(removeSpy).toHaveBeenCalledWith("ctrl-consumed", added?.[1]);
    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});

describe("MobileTerminalToolbar press flash", () => {
  it("flashes only the pressed key and clears it after 420ms", () => {
    renderToolbar();

    const esc = button("Send Escape");
    const enter = button("Send Enter");

    fireEvent.click(esc);
    // The flash is re-armed on the next frame so a repeated press restarts the
    // CSS animation instead of being deduped by an unchanged token.
    expect(esc.getAttribute("data-flash-state")).toBe("");
    advanceFrames();

    expect(esc.getAttribute("data-flash-state")).toMatch(/^flash-\d+$/);
    expect(esc.className).toContain("animate-mobile-toolbar-flash");
    expect(enter.getAttribute("data-flash-state")).toBe("");
    expect(enter.className).not.toContain("animate-mobile-toolbar-flash");

    act(() => {
      vi.advanceTimersByTime(419);
    });
    expect(esc.getAttribute("data-flash-state")).toMatch(/^flash-\d+$/);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(esc.getAttribute("data-flash-state")).toBe("");
    expect(esc.className).not.toContain("animate-mobile-toolbar-flash");
  });

  it("does not flash the ctrl toggle", () => {
    renderToolbar();

    // Flash one real key first: the single flash slot is shared, so arming
    // ctrl through triggerFlash would blank the key the user just pressed.
    fireEvent.click(button("Send Escape"));
    advanceFrames();
    const escFlash = button("Send Escape").getAttribute("data-flash-state");
    expect(escFlash).toMatch(/^flash-\d+$/);

    fireEvent.pointerDown(ctrlButton());
    advanceFrames(2);

    // Ctrl is a sticky modifier, not a keypress — it shows its armed state
    // through the ring instead, and must not render the press animation or
    // the flash token the other controls use.
    expect(ctrlButton().getAttribute("data-flash-state")).toBeNull();
    expect(ctrlButton().className).not.toContain(
      "animate-mobile-toolbar-flash"
    );
    expect(button("Send Escape").getAttribute("data-flash-state")).toBe(
      escFlash
    );
    for (const label of ["Send Enter", "Open text input"]) {
      expect(button(label).getAttribute("data-flash-state")).toBe("");
    }
  });
});

describe("MobileTerminalToolbar copy-mode banner", () => {
  const banner = () =>
    screen.queryByTestId(
      "terminal-copy-mode-banner"
    ) as HTMLButtonElement | null;

  it("appears only while input is paused", () => {
    const { rerender } = renderToolbar({ copyMode: "live" });
    expect(banner()).toBeNull();

    // The terminal reports "unknown" until the first copy-mode poll lands;
    // treating that as paused would flash the banner on every attach.
    rerender({ copyMode: "unknown" });
    expect(banner()).toBeNull();

    rerender({ copyMode: "copy" });
    expect(banner()).not.toBeNull();

    rerender({ copyMode: "exiting" });
    expect(banner()).not.toBeNull();
  });

  it("exits copy mode when tapped", () => {
    const { onExitCopyMode } = renderToolbar({ copyMode: "copy" });

    fireEvent.click(banner() as HTMLButtonElement);

    expect(onExitCopyMode).toHaveBeenCalledTimes(1);
  });

  it("stays inert while the terminal is disconnected", () => {
    const { onExitCopyMode } = renderToolbar({
      copyMode: "copy",
      isConnected: false,
    });

    expect((banner() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(banner() as HTMLButtonElement);

    expect(onExitCopyMode).not.toHaveBeenCalled();
  });
});

describe("MobileTerminalToolbar sound cues", () => {
  it("plays a tap cue for presses when cues are enabled", () => {
    renderToolbar({ soundCuesEnabled: true });

    fireEvent.click(button("Send Enter"));
    expect(playTapCueMock).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(ctrlButton());
    expect(playTapCueMock).toHaveBeenCalledTimes(2);
  });

  it("stays silent when cues are disabled without swallowing the key", () => {
    const { onSendInput, ctrlPendingRef } = renderToolbar({
      soundCuesEnabled: false,
    });

    fireEvent.click(button("Send Enter"));
    fireEvent.pointerDown(ctrlButton());

    expect(playTapCueMock).not.toHaveBeenCalled();
    expect(onSendInput.mock.calls).toEqual([["\r"]]);
    expect(ctrlPendingRef.current).toBe(true);
  });
});

describe("MobileTerminalToolbar fullscreen composer", () => {
  const submitButton = () => button("Submit with Enter");
  const pasteButton = () => button("Paste without submitting");

  it("focuses the textarea only after the layout frame", () => {
    renderToolbar();

    fireEvent.click(button("Open text input"));
    const textarea = screen.getByPlaceholderText(PLACEHOLDER);

    // iOS refuses to raise the keyboard if focus lands before the overlay is
    // laid out, so the focus is deferred by two frames — one frame is not
    // enough, and that must not be able to regress silently.
    advanceFrames();
    expect(document.activeElement).not.toBe(textarea);

    advanceFrames();
    expect(document.activeElement).toBe(textarea);
  });

  it("submits the draft through the inject-text API and closes on success", async () => {
    apiMock.mockResolvedValue(null);
    const { onSendInput } = renderToolbar();

    typeDraft(openComposer(), "pnpm run test");
    fireEvent.click(submitButton());
    await flush();

    expect(apiMock).toHaveBeenCalledTimes(1);
    const [path, init] = apiMock.mock.calls[0];
    expect(path).toBe("/api/v1/agents/agt_1/terminal/inject-text");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      text: "pnpm run test",
      submit: true,
    });
    // Injection is routed through tmux paste-buffer precisely so it does not
    // race raw keystrokes — nothing may leak onto the socket callback.
    expect(onSendInput).not.toHaveBeenCalled();
    expect(composer()).toBeNull();
  });

  it("pastes without submitting", async () => {
    apiMock.mockResolvedValue(null);
    renderToolbar();

    typeDraft(openComposer(), "some text");
    fireEvent.click(pasteButton());
    await flush();

    expect(JSON.parse(String(apiMock.mock.calls[0][1]?.body))).toEqual({
      text: "some text",
      submit: false,
    });
  });

  it("keeps the draft and the overlay when the request fails", async () => {
    apiMock.mockRejectedValue(new Error("boom"));
    renderToolbar();

    const textarea = openComposer();
    typeDraft(textarea, "important command");
    // Tapping Submit takes focus off the textarea on a real device. Without
    // reproducing that here the composer would still be holding focus from
    // the open, and the recovery refocus would be unobservable.
    act(() => {
      submitButton().focus();
    });
    fireEvent.click(submitButton());
    await flush();

    expect(toastError).toHaveBeenCalledWith("Failed to send input");
    expect(composer()).toBe(textarea);
    expect(textarea.value).toBe("important command");
    expect(document.activeElement).toBe(textarea);
  });

  it("blocks a second send while one is in flight", async () => {
    let resolveInject: () => void = () => {};
    apiMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInject = () => resolve(null);
        })
    );
    renderToolbar();

    typeDraft(openComposer(), "slow command");
    fireEvent.click(submitButton());
    await flush();

    expect(submitButton().disabled).toBe(true);
    expect(pasteButton().disabled).toBe(true);
    fireEvent.click(pasteButton());
    expect(apiMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveInject();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(composer()).toBeNull();
  });

  it("closes without a request when the draft is empty", async () => {
    renderToolbar();

    openComposer();
    fireEvent.click(submitButton());
    await flush();

    expect(apiMock).not.toHaveBeenCalled();
    expect(composer()).toBeNull();
  });

  it("discards the draft on cancel without sending it", async () => {
    renderToolbar();

    typeDraft(openComposer(), "never mind");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await flush();

    expect(apiMock).not.toHaveBeenCalled();
    expect(composer()).toBeNull();
  });

  it("sends nothing when no agent is connected to inject into", async () => {
    // Paste/Submit are gated on isConnected only, so an attached socket with
    // no resolved agent id has to be caught in the handler — the URL would
    // otherwise be built with a literal "null".
    renderToolbar({ agentId: null });

    const textarea = openComposer();
    typeDraft(textarea, "ls");
    fireEvent.click(submitButton());
    await flush();

    expect(apiMock).not.toHaveBeenCalled();
    expect(composer()).toBe(textarea);
  });
});
