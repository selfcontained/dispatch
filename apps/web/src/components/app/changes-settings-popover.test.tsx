// @vitest-environment jsdom
import { createStore, Provider } from "jotai";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";

import { diffHideTestFilesAtom, diffViewTypeAtom } from "@/lib/store";

import { ChangesSettingsPopover } from "./changes-settings-popover";

describe("ChangesSettingsPopover", () => {
  afterEach(cleanup);

  it("forces unified on mobile without changing the desktop preference", () => {
    const store = createStore();
    store.set(diffViewTypeAtom, "split");

    const { getByTestId } = render(
      <Provider store={store}>
        <MemoryRouter>
          <ChangesSettingsPopover isMobile />
        </MemoryRouter>
      </Provider>
    );

    fireEvent.click(getByTestId("changes-settings-button"));

    const unified = screen.getByRole("button", { name: "Unified" });
    const split = screen.getByRole("button", { name: "Split" });
    expect(unified.getAttribute("aria-pressed")).toBe("true");
    expect(split.getAttribute("aria-pressed")).toBe("false");
    expect(split.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByText("Split view is available on larger screens.")
    ).toBeTruthy();

    fireEvent.click(unified);
    expect(store.get(diffViewTypeAtom)).toBe("split");
  });

  it("persists the hide test files preference", () => {
    const store = createStore();

    const { getByTestId } = render(
      <Provider store={store}>
        <MemoryRouter>
          <ChangesSettingsPopover />
        </MemoryRouter>
      </Provider>
    );

    fireEvent.click(getByTestId("changes-settings-button"));
    fireEvent.click(screen.getByTestId("changes-hide-test-files"));

    expect(store.get(diffHideTestFilesAtom)).toBe(true);
  });
});
