// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import {
  LoopSetup,
  continuationMaxIterations,
  defaultContinuationDraft,
  loopItemsFromText,
  loopItemsToText,
} from "@/components/app/jobs-continuation-fields";

function ContinuationForm({ enabled = false }: { enabled?: boolean }) {
  const [draft, setDraft] = useState({
    ...defaultContinuationDraft,
    enabled,
  });
  return (
    <>
      <LoopSetup
        draft={draft}
        onChange={setDraft}
        idPrefix="test-continuation"
      />
    </>
  );
}

describe("continuation job fields", () => {
  it("defaults new chains to ten iterations and accepts unlimited", () => {
    expect(defaultContinuationDraft.maxIterations).toBe("10");
    expect(continuationMaxIterations("10")).toBe(10);
    expect(continuationMaxIterations(" ")).toBeNull();
    expect(continuationMaxIterations("0")).toBeNull();
    expect(continuationMaxIterations("2.5")).toBeNull();
  });

  it("round-trips stored prompt text as checklist items", () => {
    expect(loopItemsFromText("- First result\n- Second result")).toEqual([
      "First result",
      "Second result",
    ]);
    expect(loopItemsToText([" First result ", "", "Second result"])).toBe(
      "- First result\n- Second result"
    );
  });

  it("reveals the Loop contract and remaining settings when enabled", () => {
    render(<ContinuationForm />);

    expect(screen.queryByRole("group", { name: "Done when" })).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Run as a loop" }));

    expect(screen.getByRole("group", { name: "Done when" })).toBeTruthy();
    expect(
      screen.getByText(/Each completed run passes its outcome/)
    ).toBeTruthy();
    expect(
      screen.getByRole("group", { name: "If a run is interrupted" })
    ).toBeTruthy();
    expect(screen.getByDisplayValue("10")).toBeTruthy();
  });

  it("adds and removes checklist items", () => {
    const { container } = render(<ContinuationForm enabled />);
    const view = within(container);

    const doneWhen = view.getByRole("group", { name: "Done when" });
    fireEvent.change(within(doneWhen).getByRole("textbox"), {
      target: { value: "The release is shipped" },
    });
    fireEvent.click(within(doneWhen).getByRole("button", { name: "Add item" }));

    expect(within(doneWhen).getAllByRole("textbox")).toHaveLength(2);
    fireEvent.click(
      within(doneWhen).getByRole("button", {
        name: "Remove done when item 2",
      })
    );
    expect(within(doneWhen).getAllByRole("textbox")).toHaveLength(1);
  });

  it("associates an invalid maximum with its accessible error", () => {
    const { container } = render(<ContinuationForm enabled />);
    const view = within(container);

    const maximum = container.querySelector<HTMLInputElement>("input");
    expect(maximum).not.toBeNull();
    if (!maximum) throw new Error("Maximum runs input was not rendered");
    expect(maximum.id).toBe("test-continuation-max-iterations");
    fireEvent.change(maximum, { target: { value: "0" } });

    expect(maximum.getAttribute("aria-invalid")).toBe("true");
    expect(maximum.getAttribute("aria-describedby")).toContain(
      "test-continuation-max-iterations-error"
    );
    expect(view.getByRole("alert").textContent).toContain(
      "Use a positive whole number"
    );
  });
});
