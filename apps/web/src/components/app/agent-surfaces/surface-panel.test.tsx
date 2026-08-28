// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SurfacePanel } from "./surface-panel";
import type { Surface, SurfaceInteractionSummary } from "./types";

const mutate = vi.fn();

vi.mock("@/hooks/use-agent-surfaces", () => ({
  makeIdempotencyKey: () => "idem-test",
  useSubmitSurfaceInteraction: () => ({ mutate }),
}));

afterEach(() => {
  cleanup();
  mutate.mockReset();
  window.localStorage.clear();
});

function surface(overrides: Partial<Surface> = {}): Surface {
  return {
    schemaVersion: 1,
    id: "surface-1",
    ownerAgentId: "agent-1",
    title: "Details",
    revision: 1,
    lifecycle: "active",
    sortOrder: 0,
    blocks: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    unresolvedInteractionCount: 0,
    latestInteractions: [],
    ...overrides,
  } as Surface;
}

function summary(
  overrides: Partial<SurfaceInteractionSummary> = {}
): SurfaceInteractionSummary {
  return {
    id: "ix_1",
    tabRevision: 1,
    blockId: "actions-1",
    actionId: "go",
    kind: "action",
    status: "queued",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function renderPanel(value: Surface) {
  render(
    <SurfacePanel
      agentId="agent-1"
      surface={value}
      isLoading={false}
      isError={false}
      onRequestRefresh={async () => {}}
    />
  );
}

const actionsBlock = {
  id: "actions-1",
  type: "actions" as const,
  actions: [{ id: "go", label: "Go", intent: "go" }],
};

describe("SurfacePanel block fallback", () => {
  it("shows a visible message for an unsupported wire block", () => {
    renderPanel(
      surface({
        blocks: [
          { id: "future-1", type: "future-block" },
        ] as unknown as Surface["blocks"],
      })
    );

    expect(
      screen.getByText("This tab contains an unsupported block type:")
    ).toBeTruthy();
    expect(screen.getByText("future-block")).toBeTruthy();
  });
});

describe("SurfacePanel interaction hydration", () => {
  it("routes each block's durable record to the matching action on first render", () => {
    renderPanel(
      surface({
        blocks: [actionsBlock],
        latestInteractions: [summary({ status: "claimed" })],
      })
    );

    expect(
      screen.getByRole("button", { name: "Go" }).hasAttribute("disabled")
    ).toBe(true);
    expect(
      screen.getByTestId("interaction-status-caption").textContent
    ).toContain("In progress");
  });

  it("leaves an action untouched when the payload's record belongs to a different block", () => {
    renderPanel(
      surface({
        blocks: [actionsBlock],
        latestInteractions: [
          summary({ blockId: "some-other-block", status: "claimed" }),
        ],
      })
    );

    expect(
      screen.getByRole("button", { name: "Go" }).hasAttribute("disabled")
    ).toBe(false);
    expect(screen.queryByTestId("interaction-status-caption")).toBeNull();
  });

  it("shows a resolved outcome for a frozen tab, with the control locked", () => {
    renderPanel(
      surface({
        lifecycle: "frozen",
        blocks: [actionsBlock],
        latestInteractions: [
          summary({
            status: "completed",
            outcomeMessage: "Shipped to canary.",
          }),
        ],
      })
    );

    expect(
      screen.getByText("This tab is archived and read-only.")
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Go" }).hasAttribute("disabled")
    ).toBe(true);
    expect(screen.getByTestId("interaction-status-caption").textContent).toBe(
      "Completed — Shipped to canary."
    );
  });
});
