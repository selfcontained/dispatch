// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActionRef } from "@/components/app/agent-surfaces/types";
import { ActionRefButton, actionButtonVariant } from "./action-ref-button";

afterEach(() => {
  cleanup();
});

const BASE: ActionRef = { id: "go", label: "Go", intent: "go" };

describe("actionButtonVariant", () => {
  it("maps each ActionRef style to its Button variant, including destructive", () => {
    expect(actionButtonVariant(undefined)).toBe("default");
    expect(actionButtonVariant("default")).toBe("default");
    expect(actionButtonVariant("primary")).toBe("primary");
    expect(actionButtonVariant("destructive")).toBe("destructive");
  });
});

describe("ActionRefButton", () => {
  it("renders the action's icon", () => {
    render(
      <ActionRefButton
        action={{ ...BASE, icon: "flag" }}
        busy={false}
        disabled={false}
      />
    );
    const button = screen.getByRole("button", { name: "Go" });
    expect(button.querySelector("svg")).not.toBeNull();
  });

  it("shows a spinner in place of the icon while busy", () => {
    render(
      <ActionRefButton
        action={{ ...BASE, icon: "flag" }}
        busy
        disabled={false}
      />
    );
    const button = screen.getByRole("button", { name: "Go" });
    expect(button.querySelector("svg.animate-spin")).not.toBeNull();
  });

  it("applies the destructive style class for a destructive action", () => {
    render(
      <ActionRefButton
        action={{ ...BASE, style: "destructive" }}
        busy={false}
        disabled={false}
      />
    );
    const button = screen.getByRole("button", { name: "Go" });
    expect(button.className).toContain("bg-destructive");
  });

  it("wires disabledReasonId as the accessible description", () => {
    render(
      <ActionRefButton
        action={BASE}
        busy={false}
        disabled
        disabledReasonId="go-disabled-reason"
      />
    );
    const button = screen.getByRole("button", { name: "Go" });
    expect(button.getAttribute("disabled")).not.toBeNull();
    expect(button.getAttribute("aria-describedby")).toBe("go-disabled-reason");
  });

  it("renders as a submit-type button when requested, for form submit reuse", () => {
    render(
      <ActionRefButton
        action={BASE}
        type="submit"
        busy={false}
        disabled={false}
      />
    );
    expect(
      screen.getByRole("button", { name: "Go" }).getAttribute("type")
    ).toBe("submit");
  });

  it("marks an authored-disabled action aria-disabled while keeping it focusable, and blocks its click", () => {
    const onClick = vi.fn();
    render(
      <ActionRefButton
        action={BASE}
        busy={false}
        disabled={false}
        authoredDisabled
        onClick={onClick}
      />
    );
    const button = screen.getByRole("button", { name: "Go" });
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.tabIndex).toBe(0);

    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("does not set aria-disabled for a plain (non-authored) disable", () => {
    render(<ActionRefButton action={BASE} busy={false} disabled />);
    const button = screen.getByRole("button", { name: "Go" });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.hasAttribute("aria-disabled")).toBe(false);
  });
});
