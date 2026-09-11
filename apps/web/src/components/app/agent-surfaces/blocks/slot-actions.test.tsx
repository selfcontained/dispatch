// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActionRef } from "@/components/app/agent-surfaces/types";
import {
  indexInteractions,
  type SurfaceInteractionIndex,
} from "@/components/app/agent-surfaces/interaction-presentation";
import { SlotActions } from "./slot-actions";

const mutate = vi.fn();
vi.mock("@/hooks/use-agent-surfaces", () => ({
  makeIdempotencyKey: () => "idem-test",
  useSubmitSurfaceInteraction: () => ({ mutate }),
}));

afterEach(() => {
  cleanup();
  mutate.mockReset();
});

function renderActions(
  actions: ActionRef[],
  overrides: {
    interactions?: SurfaceInteractionIndex;
    readOnly?: boolean;
    surfaceRevision?: number;
  } = {}
) {
  return render(
    <SlotActions
      blockId="footer"
      actions={actions}
      agentId="agt_test"
      surfaceId="surface_test"
      surfaceRevision={overrides.surfaceRevision ?? 1}
      interactions={overrides.interactions ?? new Map()}
      onRequestRefresh={async () => {}}
      readOnly={overrides.readOnly ?? false}
      idPrefix="test"
    />
  );
}

// Buttons that submit an action (main or plain, not the menu trigger) all
// carry data-action-id — the menu trigger itself does not.
function actionButtonIds(): string[] {
  return Array.from(document.querySelectorAll("[data-action-id]")).map(
    (el) => el.getAttribute("data-action-id")!
  );
}

describe("SlotActions main-action selection", () => {
  it("renders a single action as a plain button with no overflow menu", () => {
    renderActions([{ id: "go", label: "Go", intent: "go" }]);

    expect(screen.getByRole("button", { name: "Go" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
  });

  it("keeps authored order for two non-destructive actions with no primary", () => {
    renderActions([
      { id: "a", label: "A", intent: "a" },
      { id: "b", label: "B", intent: "b" },
    ]);

    expect(actionButtonIds()).toEqual(["a", "b"]);
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
  });

  it("promotes a primary-styled action to the front regardless of authored order", () => {
    renderActions([
      { id: "a", label: "A", intent: "a" },
      { id: "b", label: "B", intent: "b", style: "primary" },
    ]);

    // b is primary, so it becomes `main` and renders first even though it
    // was authored second.
    expect(actionButtonIds()).toEqual(["b", "a"]);
  });

  it("falls back to the first action when every action is destructive", () => {
    renderActions([
      { id: "a", label: "Delete", intent: "delete", style: "destructive" },
    ]);

    // A single action never needs a menu, even when destructive.
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
  });

  it("picks the first non-destructive action as main even when authored after a destructive one", () => {
    renderActions([
      { id: "del", label: "Delete", intent: "delete", style: "destructive" },
      { id: "save", label: "Save", intent: "save" },
    ]);

    expect(actionButtonIds()).toEqual(["save"]);
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "More actions" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });
});

describe("SlotActions overflow menu", () => {
  it("opens a menu once there is more than one non-main action", () => {
    renderActions([
      { id: "a", label: "Save", intent: "save" },
      { id: "b", label: "Retry", intent: "retry" },
      { id: "c", label: "Archive", intent: "archive" },
    ]);

    expect(screen.getByRole("button", { name: "More actions" })).toBeTruthy();
    expect(actionButtonIds()).toEqual(["a"]);
  });
});

describe("SlotActions confirm flow", () => {
  const confirmAction: ActionRef = {
    id: "delete",
    label: "Delete",
    intent: "delete",
    confirm: { title: "Delete this?", description: "This can't be undone." },
  };

  it("opens the confirm dialog instead of submitting immediately", () => {
    renderActions([confirmAction]);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(screen.getByText("Delete this?")).toBeTruthy();
    expect(screen.getByText("This can't be undone.")).toBeTruthy();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("does not submit when the confirm dialog is cancelled", () => {
    renderActions([confirmAction]);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(mutate).not.toHaveBeenCalled();
    expect(screen.queryByText("Delete this?")).toBeNull();
  });

  it("submits with the slot's blockId and baseRevision once confirmed", () => {
    renderActions([confirmAction], { surfaceRevision: 7 });

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "action",
        blockId: "footer",
        actionId: "delete",
        baseRevision: 7,
      }),
      expect.any(Object)
    );
    expect(screen.queryByText("Delete this?")).toBeNull();
  });

  it("submits immediately for an action with no confirm", () => {
    renderActions([{ id: "go", label: "Go", intent: "go" }]);

    fireEvent.click(screen.getByRole("button", { name: "Go" }));

    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: "go" }),
      expect.any(Object)
    );
  });
});

describe("SlotActions readOnly and durable state", () => {
  it("renders the main action natively disabled when the slot is read-only", () => {
    renderActions([{ id: "go", label: "Go", intent: "go" }], {
      readOnly: true,
    });

    expect(
      screen.getByRole("button", { name: "Go" }).hasAttribute("disabled")
    ).toBe(true);
  });

  it("shows the pending caption and locks the button for a claimed durable action", () => {
    const interactions = indexInteractions([
      {
        id: "ix_1",
        tabRevision: 1,
        blockId: "footer",
        actionId: "go",
        kind: "action",
        status: "claimed",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    renderActions([{ id: "go", label: "Go", intent: "go" }], { interactions });

    expect(
      screen.getByRole("button", { name: "Go" }).hasAttribute("disabled")
    ).toBe(true);
    expect(
      screen.getByTestId("interaction-status-caption").textContent
    ).toContain("In progress");
  });

  it("shows the authored disabledReason for a disabled action with no interaction to report", () => {
    renderActions([
      {
        id: "go",
        label: "Go",
        intent: "go",
        disabled: true,
        disabledReason: "Waiting on approval",
      },
    ]);

    expect(screen.getByText("Waiting on approval")).toBeTruthy();
    // Authored-disabled stays focusable (aria-disabled), unlike a native lock.
    const button = screen.getByRole("button", { name: "Go" });
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
  });
});
