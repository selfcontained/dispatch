// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ToggleSettingCard } from "./toggle-setting-card";

afterEach(() => {
  cleanup();
});

function renderCard(
  overrides: Partial<Parameters<typeof ToggleSettingCard>[0]> = {}
) {
  const onCheckedChange = vi.fn();
  render(
    <ToggleSettingCard
      eyebrow="Prompt delivery"
      description="What the setting does."
      label="Hold automated prompts"
      hint="When on, a badge appears."
      testId="probe-toggle"
      checked={false}
      onCheckedChange={onCheckedChange}
      error=""
      {...overrides}
    />
  );
  return { onCheckedChange };
}

describe("ToggleSettingCard", () => {
  it("renders the copy and reflects the unchecked state", () => {
    renderCard();

    expect(screen.getByText("Prompt delivery")).toBeTruthy();
    expect(screen.getByText("What the setting does.")).toBeTruthy();
    expect(screen.getByText("Hold automated prompts")).toBeTruthy();
    expect(screen.getByText("When on, a badge appears.")).toBeTruthy();
    expect(screen.getByTestId("probe-toggle").getAttribute("data-state")).toBe(
      "unchecked"
    );
  });

  it("reflects the checked state", () => {
    renderCard({ checked: true });

    expect(screen.getByTestId("probe-toggle").getAttribute("data-state")).toBe(
      "checked"
    );
  });

  it("reports a boolean when toggled on", () => {
    const { onCheckedChange } = renderCard();

    fireEvent.click(screen.getByTestId("probe-toggle"));

    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("reports a boolean when toggled off", () => {
    const { onCheckedChange } = renderCard({ checked: true });

    fireEvent.click(screen.getByTestId("probe-toggle"));

    expect(onCheckedChange).toHaveBeenCalledWith(false);
  });

  it("renders no alert when the error is empty", () => {
    renderCard();

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders the error as an alert", () => {
    renderCard({ error: "Failed to save prompt delivery setting." });

    expect(screen.getByRole("alert").textContent).toBe(
      "Failed to save prompt delivery setting."
    );
  });

  it("renders rich description and hint nodes", () => {
    renderCard({
      description: (
        <>
          Adds a <strong>Chat</strong> tab.
        </>
      ),
      hint: <em>Nothing changes when off.</em>,
    });

    expect(screen.getByText("Chat").tagName).toBe("STRONG");
    expect(screen.getByText("Nothing changes when off.").tagName).toBe("EM");
  });
});
