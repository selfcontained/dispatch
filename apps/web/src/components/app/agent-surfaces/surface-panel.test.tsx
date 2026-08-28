// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

const sectionBlock = {
  id: "section-1",
  type: "section" as const,
  title: "Deployment",
  blocks: [{ id: "note-1", type: "text" as const, text: "Ready to ship." }],
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

describe("SurfacePanel sections", () => {
  it("renders a static grouping with its visible heading and nested content", () => {
    renderPanel(surface({ blocks: [sectionBlock] }));

    expect(screen.getByText("Deployment")).toBeTruthy();
    expect(screen.getByText("Ready to ship.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Deployment" })).toBeNull();
  });

  it("renders collapsible content expanded by default and toggles it", () => {
    renderPanel(
      surface({
        blocks: [
          {
            ...sectionBlock,
            description: "Expand for release status.",
            collapse: {},
          },
        ],
      })
    );

    const toggle = screen.getByRole("button", { name: "Deployment" });
    const content = document.getElementById(
      toggle.getAttribute("aria-controls")!
    )!;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(content.hidden).toBe(false);
    expect(screen.getByText("Ready to ship.")).toBeTruthy();
    expect(screen.getByText("Expand for release status.")).toBeTruthy();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(content.hidden).toBe(true);
    expect(screen.getByText("Ready to ship.")).toBeTruthy();
    expect(screen.getByText("Expand for release status.")).toBeTruthy();

    fireEvent.click(toggle);
    expect(content.hidden).toBe(false);
    expect(screen.getByText("Ready to ship.")).toBeTruthy();
  });

  it("starts initially collapsed and preserves durable interaction state when reopened", () => {
    renderPanel(
      surface({
        blocks: [
          {
            id: "section-1",
            type: "section",
            title: "Deploy",
            collapse: { initiallyCollapsed: true },
            blocks: [actionsBlock],
          },
        ] as Surface["blocks"],
        latestInteractions: [summary({ status: "claimed" })],
      })
    );

    const toggle = screen.getByRole("button", { name: "Deploy" });
    const content = document.getElementById(
      toggle.getAttribute("aria-controls")!
    )!;
    expect(screen.getByRole("heading", { name: "Deploy" })).toBeTruthy();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(content.hidden).toBe(true);
    expect(screen.queryByRole("button", { name: "Go" })).toBeNull();

    fireEvent.click(toggle);
    expect(content.hidden).toBe(false);
    expect(
      screen.getByRole("button", { name: "Go" }).hasAttribute("disabled")
    ).toBe(true);
    expect(
      screen.getByTestId("interaction-status-caption").textContent
    ).toContain("In progress");
  });

  it("preserves an unsubmitted nested form draft when the section is reopened", () => {
    renderPanel(
      surface({
        blocks: [
          {
            id: "section-1",
            type: "section",
            title: "Feedback",
            collapse: {},
            blocks: [
              {
                id: "feedback-1",
                type: "form",
                fields: [{ id: "note", type: "text", label: "Note" }],
                submit: { id: "send", label: "Send", intent: "send" },
              },
            ],
          },
        ] as Surface["blocks"],
      })
    );

    const toggle = screen.getByRole("button", { name: "Feedback" });
    const input = screen.getByLabelText("Note") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Keep this draft" } });

    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect((screen.getByLabelText("Note") as HTMLInputElement).value).toBe(
      "Keep this draft"
    );
  });

  it("keeps nested section indentation compact", () => {
    renderPanel(
      surface({
        blocks: [
          {
            ...sectionBlock,
            blocks: [{ ...sectionBlock, id: "section-2" }],
          },
        ] as Surface["blocks"],
      })
    );

    expect(
      document.querySelectorAll('[data-block-type="section"]')
    ).toHaveLength(2);
    expect(document.querySelectorAll(".border-l")).toHaveLength(2);
  });
});
