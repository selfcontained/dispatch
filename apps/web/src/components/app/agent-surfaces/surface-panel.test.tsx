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
    schemaVersion: 2,
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
    blockId: "footer",
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

const footer = { actions: [{ id: "go", label: "Go", intent: "go" }] };

const sectionBlock = {
  id: "section-1",
  type: "section" as const,
  title: "Deployment",
  blocks: [{ id: "note-1", type: "text" as const, text: "Ready to ship." }],
};

describe("SurfacePanel schema gate", () => {
  it("shows a re-create notice for a v1 document instead of rendering it", () => {
    renderPanel(
      surface({
        schemaVersion: 1,
        blocks: [
          { id: "old-1", type: "actions", actions: [] },
        ] as unknown as Surface["blocks"],
      })
    );

    expect(
      screen.getByText(
        "This tab uses an older surface format. Ask the agent to recreate it."
      )
    ).toBeTruthy();
    expect(document.querySelector("[data-block-id]")).toBeNull();
  });

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

describe("SurfacePanel document slots", () => {
  it("renders the header strip before the blocks and the footer actions last", () => {
    renderPanel(
      surface({
        header: {
          status: {
            id: "hs",
            type: "status",
            status: "Canary deployed",
            tone: "info",
          },
          progress: { id: "hp", type: "progress", value: 3, max: 10 },
        },
        blocks: [sectionBlock],
        footer,
      })
    );

    expect(screen.getByTestId("surface-header").textContent).toContain(
      "Canary deployed"
    );
    expect(screen.getByRole("progressbar")).toBeTruthy();
    const footerRegion = screen.getByTestId("surface-footer");
    expect(footerRegion.querySelector('[data-action-id="go"]')).toBeTruthy();
  });

  it("routes a footer action's durable record to the matching button", () => {
    renderPanel(
      surface({
        footer,
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

  it("leaves a footer action untouched when the record belongs to a block", () => {
    renderPanel(
      surface({
        footer,
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

  it("submits a footer action with the reserved footer block id", () => {
    renderPanel(surface({ footer }));

    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "action",
        blockId: "footer",
        actionId: "go",
      }),
      expect.any(Object)
    );
  });

  it("shows a resolved outcome for a frozen tab, with the control locked", () => {
    renderPanel(
      surface({
        lifecycle: "frozen",
        footer,
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

  it("renders section footer actions and preserves durable state when reopened", () => {
    renderPanel(
      surface({
        blocks: [
          {
            id: "section-1",
            type: "section",
            title: "Deploy",
            collapse: { initiallyCollapsed: true },
            blocks: [{ id: "note-1", type: "text", text: "Ready to ship." }],
            actions: [{ id: "go", label: "Go", intent: "go" }],
          },
        ] as Surface["blocks"],
        latestInteractions: [
          summary({ blockId: "section-1", status: "claimed" }),
        ],
      })
    );

    const toggle = screen.getByRole("button", { name: "Deploy" });
    const content = document.getElementById(
      toggle.getAttribute("aria-controls")!
    )!;
    expect(screen.getByRole("heading", { name: "Deploy" })).toBeTruthy();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(content.hidden).toBe(true);

    fireEvent.click(toggle);
    expect(content.hidden).toBe(false);
    expect(
      screen.getByRole("button", { name: "Go" }).hasAttribute("disabled")
    ).toBe(true);
    expect(
      screen.getByTestId("interaction-status-caption").textContent
    ).toContain("In progress");
  });

  it("submits a section action with the section's block id", () => {
    renderPanel(
      surface({
        blocks: [
          {
            ...sectionBlock,
            actions: [{ id: "refresh", label: "Refresh", intent: "refresh" }],
          },
        ] as Surface["blocks"],
      })
    );

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "action",
        blockId: "section-1",
        actionId: "refresh",
      }),
      expect.any(Object)
    );
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
