// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FormBlock } from "@/components/app/agent-surfaces/types";
import type {
  SurfaceInteractionResponse,
  SurfaceInteractionSummary,
} from "@/components/app/agent-surfaces/types";
import { indexInteractions } from "@/components/app/agent-surfaces/interaction-presentation";
import { FormBlockView } from "./form-block";

type Handlers = {
  onSuccess: (response: SurfaceInteractionResponse) => void;
  onError: (error: Error) => void;
};

const mutate = vi.fn<(request: unknown, handlers: Handlers) => void>();

vi.mock("@/hooks/use-agent-surfaces", () => ({
  makeIdempotencyKey: () => "idem-test",
  useSubmitSurfaceInteraction: () => ({ mutate }),
}));

afterEach(() => {
  cleanup();
  mutate.mockReset();
  window.localStorage.clear();
});

function baseBlock(overrides: Partial<FormBlock["submit"]> = {}): FormBlock {
  return {
    id: "block-1",
    type: "form",
    fields: [],
    submit: { id: "go", label: "Submit", intent: "submit", ...overrides },
  };
}

function summary(
  overrides: Partial<SurfaceInteractionSummary> = {}
): SurfaceInteractionSummary {
  return {
    id: "ix_1",
    tabRevision: 1,
    blockId: "block-1",
    actionId: "go",
    kind: "form_submit",
    status: "queued",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function formView({
  block,
  revision = 1,
  latestInteractions = [],
  onRequestRefresh = async () => {},
}: {
  block: FormBlock;
  revision?: number;
  latestInteractions?: SurfaceInteractionSummary[];
  onRequestRefresh?: () => Promise<void>;
}) {
  return (
    <FormBlockView
      block={block}
      agentId="agt_test"
      surfaceId="surface_test"
      surfaceRevision={revision}
      interactions={indexInteractions(latestInteractions)}
      onRequestRefresh={onRequestRefresh}
      readOnly={false}
      idPrefix="test"
    />
  );
}

function renderForm(
  block: FormBlock,
  revision = 1,
  onRequestRefresh: () => Promise<void> = async () => {},
  latestInteractions: SurfaceInteractionSummary[] = []
) {
  render(formView({ block, revision, latestInteractions, onRequestRefresh }));
}

describe("FormBlockView submit button", () => {
  it("sets noValidate so custom validation runs instead of native HTML5 validation", () => {
    renderForm(baseBlock());
    const form = screen.getByRole("button", { name: "Submit" }).closest("form");
    expect(form?.hasAttribute("noValidate")).toBe(true);
  });

  it("disables the reset button once the submit has settled", () => {
    mutate.mockImplementation((_req, handlers) =>
      handlers.onSuccess({
        interaction: { id: "ix", status: "queued" },
        delivery: "queued",
        duplicate: false,
      })
    );
    renderForm({ ...baseBlock(), resetLabel: "Reset" });

    const resetButton = screen.getByRole("button", { name: "Reset" });
    expect(resetButton.hasAttribute("disabled")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(screen.getByText(/Queued/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Reset" }).hasAttribute("disabled")
    ).toBe(true);
  });

  it("submits immediately when there is no confirm", () => {
    mutate.mockImplementation((_req, handlers) =>
      handlers.onSuccess({
        interaction: {
          id: "ix",
          status: "queued",
          outcomeMessage: "queued up",
        },
        delivery: "queued",
        duplicate: false,
      })
    );
    renderForm(baseBlock());

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Queued/)).toBeTruthy();
  });

  it("gates submission behind a confirm dialog when the submit action requests one", () => {
    mutate.mockImplementation((_req, handlers) =>
      handlers.onSuccess({
        interaction: { id: "ix", status: "notified" },
        delivery: "notified",
        duplicate: false,
      })
    );
    renderForm(
      baseBlock({
        confirm: {
          title: "Really submit?",
          description: "This notifies the agent.",
        },
      })
    );

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByText("Really submit?")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("marks the submit button aria-disabled (not natively disabled) and shows the reason without submitting", () => {
    renderForm(
      baseBlock({ disabled: true, disabledReason: "Waiting on approval." })
    );

    // Authored-disabled, so the button stays focusable and its reason stays
    // reachable via aria-describedby for keyboard/screen-reader users.
    const button = screen.getByRole("button", { name: "Submit" });
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    const reason = screen.getByText("Waiting on approval.");
    expect(button.getAttribute("aria-describedby")).toBe(reason.id);

    fireEvent.click(button);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("shows an error caption whose reload refreshes the surface, then clears local state back to idle", async () => {
    mutate.mockImplementation((_req, handlers) =>
      handlers.onError(new Error("send failed"))
    );
    const onRequestRefresh = vi.fn().mockResolvedValue(undefined);
    renderForm(baseBlock(), 1, onRequestRefresh);

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(screen.getByRole("alert").textContent).toContain("send failed");

    fireEvent.click(screen.getByRole("button", { name: /Reload/ }));
    expect(onRequestRefresh).toHaveBeenCalledTimes(1);

    await screen.findByRole("button", { name: "Submit" });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Submit" }).hasAttribute("disabled")
    ).toBe(false);
  });

  it("clears a local queued overlay on a revision bump when no durable record contradicts it", () => {
    mutate.mockImplementation((_req, handlers) =>
      handlers.onSuccess({
        interaction: { id: "ix", status: "queued" },
        delivery: "queued",
        duplicate: false,
      })
    );
    const { rerender } = render(formView({ block: baseBlock(), revision: 1 }));

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(screen.getByText(/Queued/)).toBeTruthy();

    rerender(formView({ block: baseBlock(), revision: 2 }));

    expect(screen.queryByText(/Queued/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Submit" }).hasAttribute("disabled")
    ).toBe(false);
  });
});

describe("FormBlockView hydration from durable records", () => {
  it("mounts an unresolved submit already disabled, with its fields locked", () => {
    const block: FormBlock = {
      ...baseBlock(),
      fields: [{ id: "note", type: "text", label: "Note" }],
      resetLabel: "Reset",
    };
    renderForm(block, 1, async () => {}, [summary({ status: "notified" })]);

    expect(
      screen.getByRole("button", { name: "Submit" }).hasAttribute("disabled")
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "Reset" }).hasAttribute("disabled")
    ).toBe(true);
    // Fields are disabled through the enclosing fieldset, so assert the
    // inherited state rather than the input's own `disabled` property.
    const noteField = screen.getByLabelText(/Note/);
    expect(noteField.closest("fieldset")?.disabled).toBe(true);
    expect(noteField.matches(":disabled")).toBe(true);
    expect(
      screen.getByTestId("interaction-status-caption").textContent
    ).toContain("Sent to the agent");
  });

  it("does not resubmit a pending form even if a submit event is dispatched directly", () => {
    renderForm(baseBlock(), 1, async () => {}, [summary({ status: "queued" })]);
    const form = screen
      .getByRole("button", { name: "Submit" })
      .closest("form")!;
    fireEvent.submit(form);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("keeps a completed once-form locked permanently, matching the server's unique index", () => {
    // tabRevision is far behind the document — a once-form still must not
    // re-arm, because the server's partial index covers `completed`.
    renderForm(baseBlock(), 99, async () => {}, [
      summary({
        status: "completed",
        tabRevision: 1,
        outcomeMessage: "Filed.",
      }),
    ]);

    expect(
      screen.getByRole("button", { name: "Submit" }).hasAttribute("disabled")
    ).toBe(true);
    expect(screen.getByTestId("interaction-status-caption").textContent).toBe(
      "Completed — Filed."
    );
  });

  it("re-arms a rejected once-form so the user can correct and resubmit, keeping the reason visible", () => {
    renderForm(baseBlock(), 1, async () => {}, [
      summary({ status: "rejected", outcomeMessage: "Add a repro case." }),
    ]);

    expect(
      screen.getByRole("button", { name: "Submit" }).hasAttribute("disabled")
    ).toBe(false);
    expect(screen.getByTestId("interaction-status-caption").textContent).toBe(
      "Declined — Add a repro case."
    );

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("re-arms a completed repeatable form while still showing what the last submission did", () => {
    renderForm(
      { ...baseBlock(), submitMode: "repeatable" },
      1,
      async () => {},
      [summary({ status: "completed", outcomeMessage: "Logged." })]
    );

    expect(
      screen.getByRole("button", { name: "Submit" }).hasAttribute("disabled")
    ).toBe(false);
    expect(screen.getByTestId("interaction-status-caption").textContent).toBe(
      "Completed — Logged."
    );
  });

  it("locks a repeatable form again while its newest submission is in flight, despite the stale terminal record", () => {
    mutate.mockImplementation((_req, handlers) =>
      handlers.onSuccess({
        interaction: { id: "ix_2", status: "queued" },
        delivery: "queued",
        duplicate: false,
      })
    );
    renderForm(
      { ...baseBlock(), submitMode: "repeatable" },
      1,
      async () => {},
      [summary({ id: "ix_1", status: "completed", outcomeMessage: "Logged." })]
    );

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    // The payload still shows ix_1; the newer local ix_2 must win, or a second
    // click would queue a duplicate.
    const submitButton = screen.getByRole("button", { name: "Submit" });
    expect(submitButton.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByTestId("interaction-status-caption").textContent
    ).toContain("Queued");
    fireEvent.click(submitButton);
    expect(mutate).toHaveBeenCalledTimes(1);
  });
});
