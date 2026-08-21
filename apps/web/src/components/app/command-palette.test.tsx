// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Plus } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CommandPalette,
  type CommandAction,
  type CommandGroup,
} from "./command-palette";

// The palette owns two things worth pinning: a hand-rolled `filter` that
// prefix-matches whole WORDS of the title plus the action's keywords (cmdk's
// default is a fuzzy score, so the narrowing is ours), and a confirm sub-page
// whose entire value is that it saves and restores the search term and the
// highlighted row. Nothing is mocked — cmdk and Radix run for real.

const hadResizeObserver = "ResizeObserver" in globalThis;
const originalResizeObserver = globalThis.ResizeObserver;

beforeEach(() => {
  // cmdk scrolls the selected option into view and observes the list's size;
  // jsdom defines neither, so these are plain assignments rather than spies and
  // vi.restoreAllMocks() would not undo them. Both are torn down symmetrically
  // below: assigning `undefined` back would leave an own property behind where
  // there was none, which is not the same thing as restoring.
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  if (hadResizeObserver) globalThis.ResizeObserver = originalResizeObserver;
  else Reflect.deleteProperty(globalThis, "ResizeObserver");
});

type Runs = {
  newAgent: ReturnType<typeof vi.fn>;
  deploy: ReturnType<typeof vi.fn>;
  window: ReturnType<typeof vi.fn>;
  shortcuts: ReturnType<typeof vi.fn>;
  archive: ReturnType<typeof vi.fn>;
  template: ReturnType<typeof vi.fn>;
};

function makeRuns(): Runs {
  return {
    newAgent: vi.fn(),
    deploy: vi.fn(),
    window: vi.fn(),
    shortcuts: vi.fn(),
    archive: vi.fn(),
    template: vi.fn(),
  };
}

// Three "New …" titles so a search for "new" leaves more than one row and the
// restored highlight has something to be wrong about; the confirm action is
// deliberately NOT first.
function makeActions(runs: Runs): CommandAction[] {
  return [
    {
      id: "new-agent",
      title: "New agent",
      keywords: ["create", "spawn"],
      icon: Plus,
      run: runs.newAgent,
    },
    {
      id: "new-deployment",
      title: "New deployment",
      confirm: { description: "This ships to production." },
      run: runs.deploy,
    },
    { id: "new-window", title: "New window", run: runs.window },
    {
      id: "keyboard-shortcuts",
      title: "Keyboard shortcuts",
      keywords: ["help"],
      run: runs.shortcuts,
    },
    {
      id: "archive-all",
      title: "Archive everything",
      disabled: true,
      run: runs.archive,
    },
  ];
}

function makeGroups(runs: Runs): CommandGroup[] {
  return [
    {
      label: "Templates",
      actions: [{ id: "tpl-1", title: "Nightly audit", run: runs.template }],
    },
    { label: "Saved searches", actions: [] },
  ];
}

function renderPalette(
  overrides: Partial<React.ComponentProps<typeof CommandPalette>> = {}
) {
  const runs = makeRuns();
  const onOpenChange = vi.fn();
  render(
    <CommandPalette
      open
      onOpenChange={onOpenChange}
      actions={makeActions(runs)}
      groups={makeGroups(runs)}
      {...overrides}
    />
  );
  return { runs, onOpenChange };
}

function input(): HTMLInputElement {
  return screen.getByPlaceholderText("Type a command…") as HTMLInputElement;
}

function type(value: string): void {
  fireEvent.change(input(), { target: { value } });
}

function selectedTitle(): string | undefined {
  return (
    screen
      .getByRole("dialog")
      .querySelector("[cmdk-item][data-selected='true']")?.textContent ??
    undefined
  );
}

describe("filtering", () => {
  it("matches a prefix of any word in the title, not a substring of it", () => {
    renderPalette();

    type("short");
    expect(screen.getByText("Keyboard shortcuts")).toBeTruthy();
    expect(screen.queryByText("New agent")).toBeNull();

    // "board" sits inside "Keyboard" but starts no word, so nothing matches.
    type("board");
    expect(screen.queryByText("Keyboard shortcuts")).toBeNull();
    expect(screen.getByText("No commands found.")).toBeTruthy();
  });

  it("matches a keyword prefix even when the title cannot match", () => {
    renderPalette();

    type("spa");

    expect(screen.getByText("New agent")).toBeTruthy();
    expect(screen.queryByText("New window")).toBeNull();
  });

  it("ignores case on both the search term and the title", () => {
    renderPalette();

    type("KEYBOARD");

    expect(screen.getByText("Keyboard shortcuts")).toBeTruthy();
  });

  it("renders only groups that have at least one action", () => {
    renderPalette();

    expect(screen.getByText("Commands")).toBeTruthy();
    expect(screen.getByText("Templates")).toBeTruthy();
    expect(screen.getByText("Nightly audit")).toBeTruthy();
    expect(screen.queryByText("Saved searches")).toBeNull();
  });

  it("renders the action icon when one is supplied", () => {
    renderPalette();

    const withIcon = screen.getByText("New agent").closest("[cmdk-item]");
    const withoutIcon = screen.getByText("New window").closest("[cmdk-item]");

    expect(withIcon?.querySelector("svg")).toBeTruthy();
    expect(withoutIcon?.querySelector("svg")).toBeNull();
  });
});

describe("running an action", () => {
  it("closes the palette before running a plain action", () => {
    const { runs, onOpenChange } = renderPalette();

    fireEvent.click(screen.getByText("New window"));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(runs.window).toHaveBeenCalledTimes(1);
    expect(onOpenChange.mock.invocationCallOrder[0]).toBeLessThan(
      runs.window.mock.invocationCallOrder[0]
    );
  });

  it("runs an action from a supplied group the same way", () => {
    const { runs, onOpenChange } = renderPalette();

    fireEvent.click(screen.getByText("Nightly audit"));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(runs.template).toHaveBeenCalledTimes(1);
  });

  it("does not run a disabled action", () => {
    const { runs, onOpenChange } = renderPalette();

    fireEvent.click(screen.getByText("Archive everything"));

    expect(runs.archive).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("clears the search when the palette is dismissed", () => {
    const { onOpenChange } = renderPalette();
    type("keyb");
    expect(input().value).toBe("keyb");

    fireEvent.keyDown(input(), { key: "Escape" });

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(input().value).toBe("");
    expect(screen.getByText("New agent")).toBeTruthy();
  });
});

describe("the confirm sub-page", () => {
  function openConfirm() {
    const rendered = renderPalette();
    type("new");
    fireEvent.click(screen.getByText("New deployment"));
    return rendered;
  }

  it("defers the action instead of running it", () => {
    const { runs, onOpenChange } = openConfirm();

    expect(runs.deploy).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByText("New deployment")).toBeTruthy();
    expect(screen.getByText("This ships to production.")).toBeTruthy();
    expect(screen.getByText("Launch")).toBeTruthy();
    expect(screen.getByText("Cancel")).toBeTruthy();
    // The command list is replaced, not merely filtered.
    expect(screen.queryByText("New window")).toBeNull();
    expect(screen.queryByText("Commands")).toBeNull();
  });

  it("arrives with an empty search", () => {
    openConfirm();

    expect(input().value).toBe("");
  });

  it("keeps both choices mounted whatever is typed", () => {
    // The search box is only visually hidden here, so it keeps taking
    // keystrokes. cmdk unmounts a row its filter rejects; the two buttons
    // survive because ConfirmPage force-mounts their group.
    openConfirm();

    type("zzz-nothing-matches-this");

    expect(screen.getByRole("option", { name: "Launch" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Cancel" })).toBeTruthy();
  });

  it("closes and runs the action on Launch", () => {
    const { runs, onOpenChange } = openConfirm();

    fireEvent.click(screen.getByText("Launch"));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(runs.deploy).toHaveBeenCalledTimes(1);
    expect(onOpenChange.mock.invocationCallOrder[0]).toBeLessThan(
      runs.deploy.mock.invocationCallOrder[0]
    );
  });

  it("restores the search term on Cancel", () => {
    const { runs, onOpenChange } = openConfirm();

    fireEvent.click(screen.getByText("Cancel"));

    expect(runs.deploy).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(input().value).toBe("new");
    expect(screen.getByText("New agent")).toBeTruthy();
    expect(screen.getByText("New window")).toBeTruthy();
    expect(screen.queryByText("Keyboard shortcuts")).toBeNull();
  });

  it("restores the highlighted row on Cancel", () => {
    // No search term, so every row is listed and the confirm action is the
    // second one. Without the saved selection, cmdk highlights the first.
    renderPalette();
    fireEvent.click(screen.getByText("New deployment"));
    expect(screen.getByText("This ships to production.")).toBeTruthy();

    fireEvent.click(screen.getByText("Cancel"));

    expect(selectedTitle()).toBe("New deployment");
  });

  it("goes back instead of closing when Escape is pressed", () => {
    const { onOpenChange } = openConfirm();

    fireEvent.keyDown(input(), { key: "Escape" });

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.queryByText("This ships to production.")).toBeNull();
    expect(input().value).toBe("new");
  });

  it("goes back on Backspace only while the search is empty", () => {
    openConfirm();

    type("abc");
    fireEvent.keyDown(input(), { key: "Backspace" });
    expect(screen.getByText("This ships to production.")).toBeTruthy();

    type("");
    fireEvent.keyDown(input(), { key: "Backspace" });
    expect(screen.queryByText("This ships to production.")).toBeNull();
    expect(input().value).toBe("new");
  });

  it("ignores Backspace once the sub-page is gone", () => {
    // popPage would replay the saved search, so a Backspace that reaches the
    // root list resurrects a term the user already cleared.
    openConfirm();
    fireEvent.click(screen.getByText("Cancel"));
    expect(input().value).toBe("new");
    type("");

    fireEvent.keyDown(input(), { key: "Backspace" });

    expect(input().value).toBe("");
    expect(screen.getByText("Keyboard shortcuts")).toBeTruthy();
  });

  it("still exits on Escape once the sub-page is gone", () => {
    const { onOpenChange } = openConfirm();
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalled();

    fireEvent.keyDown(input(), { key: "Escape" });

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("clears the page stack when the palette is dismissed from the sub-page", () => {
    const { runs, onOpenChange } = openConfirm();

    fireEvent.click(screen.getByText("Launch"));
    expect(runs.deploy).toHaveBeenCalledTimes(1);

    // Dismissal reset `pages`, so the list — not the confirm page — is what
    // stays rendered.
    expect(screen.queryByText("This ships to production.")).toBeNull();
    expect(screen.getByText("New window")).toBeTruthy();
    expect(input().value).toBe("");
    // …and with no sub-page left on the stack, Escape closes again rather
    // than being swallowed by the go-back handler.
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledTimes(2);
  });
});
