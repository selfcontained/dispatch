// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SystemEventEntry } from "./system-event-entry";

describe("system event presentation", () => {
  it("keeps risk separate from check status and exposes details to keyboard users", () => {
    render(
      <SystemEventEntry
        event={{
          category: "risk",
          summary: "Merge-risk assessment",
          risk: "routine",
          details: "Exact-head observation",
          head: "abcdef1234",
          at: "2026-11-10T17:42:00Z",
          resource: {
            label: "PR #1439",
            url: "https://github.com/a/b/pull/1439",
          },
        }}
      />
    );
    expect(screen.getByText("Routine")).toBeTruthy();
    expect(screen.queryByText("Passing")).toBeNull();
    expect(screen.getAllByRole("link")).toHaveLength(1);
    const button = screen.getByRole("button", { name: "Details" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Exact-head observation")).toBeTruthy();
    expect(screen.getByText(/Not merge approval/)).toBeTruthy();
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });
});
