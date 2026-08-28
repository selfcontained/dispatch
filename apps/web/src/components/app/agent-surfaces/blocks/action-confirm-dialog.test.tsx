// @vitest-environment jsdom
import { useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { ActionRef } from "@/components/app/agent-surfaces/types";
import { ActionConfirmDialog } from "./action-confirm-dialog";

afterEach(() => {
  cleanup();
});

const ACTION: ActionRef = {
  id: "revoke",
  label: "Revoke",
  intent: "revoke",
  confirm: { title: "Really revoke?", description: "This can't be undone." },
};

/** A trigger button + the dialog, mirroring how actions-block/form-block use
 * ActionConfirmDialog: the button that opens it stays mounted throughout. */
function Harness() {
  const [action, setAction] = useState<ActionRef | null>(null);
  return (
    <>
      <button type="button" onClick={() => setAction(ACTION)}>
        Open
      </button>
      <ActionConfirmDialog
        action={action}
        onCancel={() => setAction(null)}
        onConfirm={() => setAction(null)}
      />
    </>
  );
}

describe("ActionConfirmDialog", () => {
  it("renders nothing before the first open — no empty dialog, no missing-title warning", () => {
    render(<Harness />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("restores focus to the triggering button after Cancel", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open" });
    trigger.focus();
    fireEvent.click(trigger);

    expect(screen.getByText("Really revoke?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("restores focus to the triggering button after Confirm", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open" });
    trigger.focus();
    fireEvent.click(trigger);

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
