// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Provider } from "jotai";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BottomBar } from "./bottom-bar";

// The embedded AmbientTipBar reads matchMedia for its desktop gate; jsdom
// has no implementation.
beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

// A fresh jotai Provider per render isolates atom state between tests; the
// localStorage write-through still happens via the atom's setter.
function renderBar() {
  return render(
    <Provider>
      <MemoryRouter>
        <BottomBar />
      </MemoryRouter>
    </Provider>
  );
}

describe("BottomBar", () => {
  it("renders expanded by default with a collapse toggle", () => {
    renderBar();

    expect(screen.getByTestId("bottom-bar")).toBeTruthy();
    const toggle = screen.getByTestId("bottom-bar-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-label")).toBe("Collapse bottom bar");
  });

  it("collapses, persists the choice, and keeps the toggle focused", () => {
    renderBar();

    const toggle = screen.getByTestId("bottom-bar-toggle");
    toggle.focus();
    fireEvent.click(toggle);

    expect(screen.queryByTestId("bottom-bar")).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-label")).toBe("Expand bottom bar");
    // The toggle stays mounted across the swap, so keyboard focus survives.
    expect(document.activeElement).toBe(toggle);
    expect(window.localStorage.getItem("dispatch:bottomBarCollapsed")).toBe(
      "true"
    );
  });

  it("expands back from the collapsed toggle", () => {
    renderBar();

    const toggle = screen.getByTestId("bottom-bar-toggle");
    fireEvent.click(toggle);
    fireEvent.click(toggle);

    expect(screen.getByTestId("bottom-bar")).toBeTruthy();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(window.localStorage.getItem("dispatch:bottomBarCollapsed")).toBe(
      "false"
    );
  });
});
