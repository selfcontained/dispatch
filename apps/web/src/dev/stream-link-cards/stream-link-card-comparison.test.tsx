// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import {
  ComparisonProviders,
  StreamLinkCardComparison,
  VARIANTS,
} from "./stream-link-card-comparison";

function Location(): JSX.Element {
  const location = useLocation();
  return (
    <output data-testid="comparison-location">
      {location.pathname}
      {location.search}
      {location.hash}
    </output>
  );
}
function show(search = ""): void {
  render(
    <ComparisonProviders>
      <MemoryRouter
        initialEntries={[`/src/dev/stream-link-cards/index.html${search}`]}
      >
        <StreamLinkCardComparison />
        <Location />
      </MemoryRouter>
    </ComparisonProviders>
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-theme-mode");
});

describe("dev stream link-card comparison", () => {
  it.each(VARIANTS)(
    "keeps real card semantics and content in $id",
    ({ id }) => {
      show(`?variant=${id}&theme=light`);
      expect(
        screen.getByRole("tabpanel").getAttribute("data-comparison-variant")
      ).toBe(id);
      const links = screen.getAllByRole("link") as HTMLAnchorElement[];
      expect(links).toHaveLength(6);
      for (const external of links.slice(0, 5)) {
        expect(external.getAttribute("target")).toBe("_blank");
        expect(external.getAttribute("rel")).toBe("noreferrer");
        expect(external.getAttribute("title")).toBe(
          external.getAttribute("href")
        );
      }
      const raw = links[1];
      expect(raw.textContent).toContain(raw.getAttribute("href"));
      expect(raw.textContent).toContain("Opens in a new tab");
      expect(
        screen
          .getByRole("link", { name: "PR Keep stream resources easy to scan" })
          .getAttribute("href")
      ).toBe("https://github.com/dispatch-example/dispatch/pull/128");
      expect(
        screen
          .getByRole("link", { name: "Preview Stream card exploration" })
          .getAttribute("href")
      ).toBe("https://preview.example.com/stream-link-cards");
      const internal = links[5];
      expect(internal.getAttribute("target")).toBeNull();
      expect(internal.textContent).toContain("Opens in Dispatch");
      fireEvent.click(internal);
      expect(screen.getByTestId("comparison-location").textContent).toBe(
        "/src/dev/stream-link-cards/index.html#handoff"
      );
    }
  );

  it("switches candidates through URL state without writing the saved app theme", () => {
    localStorage.setItem("dispatch:theme", "mytra");
    show("?theme=light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.documentElement.getAttribute("data-theme-mode")).toBe(
      "light"
    );
    // Radix's automatic tabs activate on focus, matching arrow-key navigation.
    fireEvent.focus(screen.getByRole("tab", { name: "C · Balanced" }));
    expect(
      screen.getByRole("tabpanel").getAttribute("data-comparison-variant")
    ).toBe("balanced");
    expect(screen.getByTestId("comparison-location").textContent).toContain(
      "theme=light&variant=balanced"
    );
    expect(localStorage.getItem("dispatch:theme")).toBe("mytra");
  });

  it("falls back to baseline and the existing default theme for invalid URL values", () => {
    show("?variant=unknown&theme=unknown");
    expect(
      screen.getByRole("tabpanel").getAttribute("data-comparison-variant")
    ).toBe("baseline");
    expect(document.documentElement.getAttribute("data-theme")).toBe(
      "cool-navy"
    );
  });
});
