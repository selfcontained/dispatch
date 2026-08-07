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
  it("renders expanded by default with a collapse control", () => {
    renderBar();

    expect(screen.getByTestId("bottom-bar")).toBeTruthy();
    expect(screen.getByTestId("bottom-bar-collapse")).toBeTruthy();
    expect(screen.queryByTestId("bottom-bar-expand")).toBeNull();
  });

  it("collapses to a slim expand control and persists the choice", () => {
    renderBar();

    fireEvent.click(screen.getByTestId("bottom-bar-collapse"));

    expect(screen.queryByTestId("bottom-bar")).toBeNull();
    expect(screen.getByTestId("bottom-bar-expand")).toBeTruthy();
    expect(window.localStorage.getItem("dispatch:bottomBarCollapsed")).toBe(
      "true"
    );
  });

  it("expands back from the collapsed control", () => {
    renderBar();

    fireEvent.click(screen.getByTestId("bottom-bar-collapse"));
    fireEvent.click(screen.getByTestId("bottom-bar-expand"));

    expect(screen.getByTestId("bottom-bar")).toBeTruthy();
    expect(window.localStorage.getItem("dispatch:bottomBarCollapsed")).toBe(
      "false"
    );
  });
});
