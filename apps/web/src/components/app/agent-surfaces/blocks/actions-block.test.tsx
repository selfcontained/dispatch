// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActionsBlock } from "@/components/app/agent-surfaces/types";
import type {
  SurfaceInteractionResponse,
  SurfaceInteractionSummary,
} from "@/components/app/agent-surfaces/types";
import { indexInteractions } from "@/components/app/agent-surfaces/interaction-presentation";
import { ActionsBlockView } from "./actions-block";

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
});

function summary(
  overrides: Partial<SurfaceInteractionSummary> = {}
): SurfaceInteractionSummary {
  return {
    id: "ix_1",
    tabRevision: 1,
    blockId: "block-1",
    actionId: "go",
    kind: "action",
    status: "queued",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function renderActions(
  block: ActionsBlock,
  surfaceRevision = 1,
  latestInteractions: SurfaceInteractionSummary[] = []
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ActionsBlockView
        block={block}
        agentId="agt_test"
        surfaceId="surface_test"
        surfaceRevision={surfaceRevision}
        interactions={indexInteractions(latestInteractions)}
        onRequestRefresh={async () => {}}
        readOnly={false}
        idPrefix="test"
      />
    </QueryClientProvider>
  );
}

const goBlock: ActionsBlock = {
  id: "block-1",
  type: "actions",
  actions: [
    { id: "go", label: "Go", intent: "go" },
    { id: "stop", label: "Stop", intent: "stop" },
  ],
};

describe("ActionsBlockView disabledReason", () => {
  it("shows the reason as visible text and wires it as an accessible description", () => {
    renderActions({
      id: "block-1",
      type: "actions",
      actions: [
        {
          id: "revoke",
          label: "Revoke access",
          intent: "revoke_access",
          disabled: true,
          disabledReason: "No active access grant exists.",
        },
      ],
    });

    // Visible without any hover/focus interaction — not hidden behind a
    // title-attribute tooltip.
    const reason = screen.getByText("No active access grant exists.");
    expect(reason.textContent).toBe("No active access grant exists.");

    // Authored-disabled (not a native `disabled` attribute) so the button
    // stays focusable and keyboard/screen-reader users can still reach it
    // and hear the reason via aria-describedby.
    const button = screen.getByRole("button", { name: "Revoke access" });
    expect(button.getAttribute("disabled")).toBeNull();
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("aria-describedby")).toBe(reason.id);
  });

  it("does not run a disabled action even though its button stays focusable", () => {
    renderActions({
      id: "block-3",
      type: "actions",
      actions: [
        {
          id: "revoke",
          label: "Revoke access",
          intent: "revoke_access",
          disabled: true,
          disabledReason: "No active access grant exists.",
        },
      ],
    });

    const button = screen.getByRole("button", { name: "Revoke access" });
    fireEvent.click(button);
    expect(screen.queryByTestId("interaction-status-caption")).toBeNull();
  });

  it("stays disabled once queued, in both auto and stack layout, without exclusive-choice semantics for siblings", () => {
    mutate.mockImplementation((_req, handlers) =>
      handlers.onSuccess({
        interaction: { id: "ix", status: "queued" },
        delivery: "queued",
        duplicate: false,
      })
    );

    for (const layout of ["auto", "stack"] as const) {
      renderActions({ ...goBlock, id: `block-${layout}`, layout });

      const goButton = screen.getByRole("button", { name: "Go" });
      fireEvent.click(goButton);

      expect(screen.getByText(/Queued/)).toBeTruthy();
      expect(goButton.hasAttribute("disabled")).toBe(true);
      // A second click while already queued must not fire another mutate.
      fireEvent.click(goButton);
      expect(mutate).toHaveBeenCalledTimes(1);
      // The sibling action is untouched — one action settling never disables
      // another, regardless of layout; that's purely `layout`'s visual
      // stack-vs-wrap choice, not a choice/exclusivity signal.
      expect(
        screen.getByRole("button", { name: "Stop" }).hasAttribute("disabled")
      ).toBe(false);

      cleanup();
      mutate.mockClear();
    }
  });

  it("omits the description wiring for enabled actions", () => {
    renderActions({
      id: "block-2",
      type: "actions",
      actions: [{ id: "go", label: "Go", intent: "go" }],
    });

    const button = screen.getByRole("button", { name: "Go" });
    expect(button.getAttribute("disabled")).toBeNull();
    expect(button.hasAttribute("aria-disabled")).toBe(false);
    expect(button.hasAttribute("aria-describedby")).toBe(false);
  });
});

describe("ActionsBlockView hydration from durable records", () => {
  it("mounts an unresolved action already disabled, so a reload cannot queue a duplicate", () => {
    renderActions(goBlock, 1, [summary({ status: "claimed" })]);

    const goButton = screen.getByRole("button", { name: "Go" });
    expect(goButton.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByTestId("interaction-status-caption").textContent
    ).toContain("In progress");

    fireEvent.click(goButton);
    expect(mutate).not.toHaveBeenCalled();
    // Only the action with a durable record is affected.
    expect(
      screen.getByRole("button", { name: "Stop" }).hasAttribute("disabled")
    ).toBe(false);
  });

  it("shows the agent's rejection reason and re-arms the action for a retry", () => {
    renderActions(goBlock, 1, [
      summary({ status: "rejected", outcomeMessage: "Not enough context." }),
    ]);

    const caption = screen.getByTestId("interaction-status-caption");
    expect(caption.textContent).toBe("Declined — Not enough context.");
    expect(
      screen.getByRole("button", { name: "Go" }).hasAttribute("disabled")
    ).toBe(false);
  });

  it("keeps a completed action settled at the revision it acted on, then re-arms without losing the outcome", () => {
    const done = summary({
      status: "completed",
      tabRevision: 4,
      outcomeMessage: "Deployed.",
    });
    renderActions(goBlock, 4, [done]);
    expect(
      screen.getByRole("button", { name: "Go" }).hasAttribute("disabled")
    ).toBe(true);
    expect(screen.getByTestId("interaction-status-caption").textContent).toBe(
      "Completed — Deployed."
    );

    cleanup();
    renderActions(goBlock, 5, [done]);
    expect(
      screen.getByRole("button", { name: "Go" }).hasAttribute("disabled")
    ).toBe(false);
    expect(screen.getByTestId("interaction-status-caption").textContent).toBe(
      "Completed — Deployed."
    );
  });

  it("keeps a durable outcome visible across a revision bump that clears local state", () => {
    // The local overlay resets on a revision bump; the caption must survive
    // that because it is rendered from the server payload, not from state.
    const resolved = summary({
      status: "rejected",
      tabRevision: 1,
      outcomeMessage: "Denied by policy.",
    });
    const interactions = indexInteractions([resolved]);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const view = (revision: number) => (
      <QueryClientProvider client={queryClient}>
        <ActionsBlockView
          block={goBlock}
          agentId="agt_test"
          surfaceId="surface_test"
          surfaceRevision={revision}
          interactions={interactions}
          onRequestRefresh={async () => {}}
          readOnly={false}
          idPrefix="test"
        />
      </QueryClientProvider>
    );

    const { rerender } = render(view(1));
    expect(
      screen.getByTestId("interaction-status-caption").textContent
    ).toContain("Denied by policy.");

    rerender(view(2));
    expect(
      screen.getByTestId("interaction-status-caption").textContent
    ).toContain("Denied by policy.");
  });

  it("does not re-arm on a failed POST when the durable record shows the interaction did queue", () => {
    mutate.mockImplementation((_req, handlers) =>
      handlers.onError(new Error("network down"))
    );
    renderActions(goBlock, 1, [summary({ status: "queued" })]);

    const goButton = screen.getByRole("button", { name: "Go" });
    expect(goButton.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByTestId("interaction-status-caption").textContent
    ).toContain("Queued");
  });
});
