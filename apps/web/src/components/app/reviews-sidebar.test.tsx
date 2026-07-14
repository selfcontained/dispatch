// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import type { ReviewListItem } from "@/hooks/use-agent-reviews";
import { ReviewsSidebarContent } from "./reviews-sidebar";

const reviews: ReviewListItem[] = [
  {
    id: 1,
    agentId: "agent-1",
    assignedAgentId: "agent-1",
    reviewerType: "human",
    reviewerAgentId: null,
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
    summary: "Partially resolved review",
    status: "partially_resolved",
    baseRef: "main",
    createdAt: "2026-07-13T16:00:00.000Z",
    updatedAt: "2026-07-13T16:00:00.000Z",
    itemCount: 2,
    resolvedCount: 1,
  },
];

vi.mock("@/hooks/use-agent-reviews", () => ({
  useAgentReviews: () => ({ reviews, isLoading: false }),
  useAgentReviewDetail: () => ({ review: null, isLoading: false }),
  useAddReviewThreadMessage: vi.fn(),
  useSetReviewFeedbackResolution: vi.fn(),
}));

vi.mock("@/hooks/use-agent-diff", () => ({
  useAgentDiff: () => ({ data: null }),
}));

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
});
