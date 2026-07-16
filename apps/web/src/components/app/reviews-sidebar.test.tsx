// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReviewListItem } from "@/hooks/use-agent-reviews";
import { ReviewsSidebarContent } from "./reviews-sidebar";

const reviews: ReviewListItem[] = [
  {
    id: 1,
    agentId: "agent-1",
    assignedAgentId: "agent-1",
    reviewerType: "human",
    reviewerAgentId: null,
    reviewerName: null,
    summary: null,
    status: "open",
    baseRef: "main",
    createdAt: "2026-07-13T18:00:00.000Z",
    updatedAt: "2026-07-13T18:00:00.000Z",
    itemCount: 2,
    resolvedCount: 0,
  },
  {
    id: 2,
    agentId: "agent-1",
    assignedAgentId: "agent-1",
    reviewerType: "human",
    reviewerAgentId: null,
    reviewerName: null,
    summary: "Resolved review",
    status: "resolved",
    baseRef: "main",
    createdAt: "2026-07-13T17:00:00.000Z",
    updatedAt: "2026-07-13T17:00:00.000Z",
    itemCount: 1,
    resolvedCount: 1,
  },
  {
    id: 3,
    agentId: "agent-1",
    assignedAgentId: "agent-1",
    reviewerType: "human",
    reviewerAgentId: null,
    reviewerName: null,
    summary: "Partially resolved review",
    status: "partially_resolved",
    baseRef: "main",
    createdAt: "2026-07-13T16:00:00.000Z",
    updatedAt: "2026-07-13T16:00:00.000Z",
    itemCount: 2,
    resolvedCount: 1,
  },
  {
    id: 4,
    agentId: "agent-1",
    assignedAgentId: "agent-1",
    reviewerType: "agent",
    reviewerAgentId: "reviewer-1",
    reviewerName: "Security Review",
    summary: "No actionable security issues found.",
    status: "resolved",
    baseRef: "main",
    createdAt: "2026-07-13T15:00:00.000Z",
    updatedAt: "2026-07-13T15:00:00.000Z",
    itemCount: 0,
    resolvedCount: 0,
  },
  {
    id: 5,
    agentId: "agent-1",
    assignedAgentId: "agent-1",
    reviewerType: "agent",
    reviewerAgentId: "reviewer-2",
    reviewerName: "Product Review",
    summary: "Actionable **reviewer feedback**",
    status: "open",
    baseRef: "main",
    createdAt: "2026-07-13T14:00:00.000Z",
    updatedAt: "2026-07-13T14:00:00.000Z",
    itemCount: 1,
    resolvedCount: 0,
  },
];

const threadReview = {
  ...reviews[4],
  items: [
    {
      id: 51,
      reviewId: 5,
      filePath: "apps/web/src/example.tsx",
      lineStart: 10,
      lineEnd: 10,
      diffSnapshot: null,
      baseRef: "main",
      status: "resolved",
      resolution: "fixed",
      resolutionNote: "Implementation verified",
      resolvedBy: "human",
      resolvedAt: "2026-07-13T14:03:00.000Z",
      createdAt: "2026-07-13T14:00:00.000Z",
      updatedAt: "2026-07-13T14:03:00.000Z",
      messages: [
        {
          id: 510,
          feedbackItemId: 51,
          authorType: "agent",
          authorAgentId: "reviewer-2",
          type: "feedback",
          content: {
            body: "Clarify the **review state**.\n\n- Preserve the tracked thread\n- Keep the full explanation visible when expanded",
          },
          createdAt: "2026-07-13T14:00:00.000Z",
        },
        {
          id: 511,
          feedbackItemId: 51,
          authorType: "human",
          authorAgentId: null,
          type: "message",
          content: { body: "Updated the copy." },
          createdAt: "2026-07-13T14:02:00.000Z",
        },
        {
          id: 512,
          feedbackItemId: 51,
          authorType: "human",
          authorAgentId: null,
          type: "resolution",
          content: { body: "Implementation verified", resolution: "fixed" },
          createdAt: "2026-07-13T14:03:00.000Z",
        },
      ],
    },
  ],
};

vi.mock("@/hooks/use-agent-reviews", () => ({
  useAgentReviews: () => ({ reviews, isLoading: false }),
  useAgentReviewDetail: (_agentId: string, reviewId: number) => ({
    review:
      reviewId === 4
        ? { ...reviews[3], items: [] }
        : reviewId === 5
          ? threadReview
          : null,
    isLoading: false,
  }),
  useAddReviewThreadMessage: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useSetReviewFeedbackResolution: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
    variables: undefined,
  }),
}));

vi.mock("@/hooks/use-agent-diff", () => ({
  useAgentDiff: () => ({ data: null }),
}));

afterEach(cleanup);

function reviewRowFor(text: string): HTMLElement {
  const row = screen.getByText(text).closest("button")?.parentElement;
  if (!row) throw new Error(`Could not find review row for ${text}`);
  return row;
}

describe("ReviewsSidebarContent", () => {
  it("uses status rails and labels a review without a summary", () => {
    render(
      <MemoryRouter>
        <ReviewsSidebarContent agentId="agent-1" />
      </MemoryRouter>
    );

    expect(reviewRowFor("Review feedback").className).toContain(
      "border-l-status-waiting/60"
    );
    expect(reviewRowFor("Partially resolved review").className).toContain(
      "border-l-status-waiting/60"
    );
    expect(reviewRowFor("Resolved review").className).toContain(
      "border-l-status-working/60"
    );
  });

  it("shows reviewer attribution and expands a tracked clean approval", () => {
    render(
      <MemoryRouter>
        <ReviewsSidebarContent agentId="agent-1" />
      </MemoryRouter>
    );

    expect(screen.getByText("Security Review")).toBeTruthy();
    expect(screen.getByText("Approved · no feedback")).toBeTruthy();
    fireEvent.click(screen.getByText("No actionable security issues found."));
    expect(screen.getByText("Approved without feedback")).toBeTruthy();
  });

  it("describes submitted agent feedback and preserves state-change context", () => {
    render(
      <MemoryRouter>
        <ReviewsSidebarContent agentId="agent-1" />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByTestId("review-summary-5"));
    expect(
      screen.getByText(/Reviewer feedback submitted — awaiting action/)
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Expand feedback" }));
    expect(screen.getByText("State change")).toBeTruthy();
    expect(screen.getByText(/Marked fixed/)).toBeTruthy();
    expect(screen.getAllByText(/Implementation verified/)).toHaveLength(2);
  });

  it("clips collapsed feedback and renders its full body as markdown", () => {
    render(
      <MemoryRouter>
        <ReviewsSidebarContent agentId="agent-1" />
      </MemoryRouter>
    );

    const reviewSummary = screen.getByTestId("review-summary-5");
    expect(reviewSummary.querySelector("strong")?.textContent).toBe(
      "reviewer feedback"
    );
    fireEvent.click(reviewSummary);
    const body = screen.getByTestId("feedback-body-51");
    expect(body.className).toContain("max-h-[4.35em]");
    expect(body.querySelector("strong")?.textContent).toBe("review state");
    expect(screen.getByText("Preserve the tracked thread")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Expand feedback description" })
    );
    expect(body.className).not.toContain("max-h-[4.35em]");
    expect(
      screen.getByText("Keep the full explanation visible when expanded")
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Collapse feedback description" })
    );
    expect(body.className).toContain("max-h-[4.35em]");
  });
});
