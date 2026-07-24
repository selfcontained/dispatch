// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
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
    summary:
      "Actionable **reviewer feedback** — [details](https://example.com/review)",
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
            body: "Clarify the **review state**.\n\n- Preserve the tracked thread\n- Keep the full explanation visible when expanded\n\n[Read guidance](https://example.com/guidance)",
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

function reviewRowById(id: number): HTMLElement {
  const row = document.querySelector(`[data-review-id="${id}"]`);
  if (!row) throw new Error(`Could not find review row ${id}`);
  return row as HTMLElement;
}

function LocationSearch(): JSX.Element {
  return <output data-testid="location-search">{useLocation().search}</output>;
}

describe("ReviewsSidebarContent", () => {
  it("uses status rails and labels review headers", () => {
    render(
      <MemoryRouter>
        <ReviewsSidebarContent agentId="agent-1" />
      </MemoryRouter>
    );

    expect(reviewRowById(1).className).toContain("border-l-status-waiting/60");
    expect(reviewRowById(3).className).toContain("border-l-status-waiting/60");
    expect(reviewRowById(2).className).toContain("border-l-status-working/60");
  });

  it("shows reviewer attribution and expands a tracked clean approval", () => {
    render(
      <MemoryRouter>
        <ReviewsSidebarContent agentId="agent-1" />
      </MemoryRouter>
    );

    expect(
      screen.getByRole("button", {
        name: "Expand review from Security Review",
      })
    ).toBeTruthy();
    expect(screen.getByText("Approved · no feedback")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Expand review from Security Review",
      })
    );
    expect(screen.getByText("Approved without feedback")).toBeTruthy();
  });

  it("keeps the expanded review in URL state", () => {
    render(
      <MemoryRouter initialEntries={["/agents/agent-1?expandReview=5"]}>
        <ReviewsSidebarContent agentId="agent-1" />
        <LocationSearch />
      </MemoryRouter>
    );

    expect(screen.getByTestId("review-description-5")).toBeTruthy();
    expect(screen.getByTestId("location-search").textContent).toBe(
      "?expandReview=5"
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Collapse review from Product Review",
      })
    );
    expect(screen.getByTestId("location-search").textContent).toBe("");
  });

  it("describes submitted agent feedback and preserves state-change context", () => {
    render(
      <MemoryRouter>
        <ReviewsSidebarContent agentId="agent-1" />
      </MemoryRouter>
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Expand review from Product Review",
      })
    );
    expect(
      screen.getByText(/Reviewer feedback submitted — awaiting action/)
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Expand feedback" }));
    expect(screen.getByText("State change")).toBeTruthy();
    expect(screen.getByText(/Marked fixed/)).toBeTruthy();
    expect(screen.getAllByText(/Implementation verified/)).toHaveLength(2);
  });

  it("keeps descriptions out of the toggle and renders them as markdown", () => {
    render(
      <MemoryRouter>
        <ReviewsSidebarContent agentId="agent-1" />
      </MemoryRouter>
    );

    expect(screen.queryByTestId("review-description-5")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Expand review from Product Review",
      })
    );
    const reviewDescription = screen.getByTestId("review-description-5");
    expect(reviewDescription.querySelector("strong")?.textContent).toBe(
      "reviewer feedback"
    );
    expect(reviewDescription.closest("button")).toBeNull();
    expect(screen.queryByTestId("feedback-description-51")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Expand feedback" }));
    const feedbackDescription = screen.getByTestId("feedback-description-51");
    expect(feedbackDescription.querySelector("strong")?.textContent).toBe(
      "review state"
    );
    expect(feedbackDescription.closest("button")).toBeNull();
    expect(
      screen.getByText("Keep the full explanation visible when expanded")
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Collapse feedback" }));
    expect(
      screen
        .getByRole("button", { name: "Expand feedback" })
        .getAttribute("aria-expanded")
    ).toBe("false");
  });

  it("keeps Markdown links outside review and feedback toggle buttons", () => {
    render(
      <MemoryRouter>
        <ReviewsSidebarContent agentId="agent-1" />
        <LocationSearch />
      </MemoryRouter>
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Expand review from Product Review",
      })
    );
    const reviewLink = screen.getByRole("link", { name: "details" });
    expect(reviewLink.closest("button")).toBeNull();
    reviewLink.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(reviewLink);
    expect(screen.getByTestId("location-search").textContent).toBe(
      "?expandReview=5"
    );

    fireEvent.click(screen.getByRole("button", { name: "Expand feedback" }));
    const feedbackLink = screen.getByRole("link", { name: "Read guidance" });
    expect(feedbackLink.closest("button")).toBeNull();
    feedbackLink.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(feedbackLink);
    expect(
      screen
        .getByRole("button", { name: "Collapse feedback" })
        .getAttribute("aria-expanded")
    ).toBe("true");
  });
});
