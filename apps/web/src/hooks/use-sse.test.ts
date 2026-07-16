// @vitest-environment jsdom
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { agentDiffQueryKey } from "@/hooks/use-agent-diff";
import { diffStatsQueryKey } from "@/hooks/use-agent-diff-stats";

import { type Agent } from "@/components/app/types";

import {
  applyAgentUpsert,
  applyDiffStateChanged,
  applyReviewCreated,
} from "./use-sse";

function agent(
  id: string,
  hasSubmittedReview: boolean,
  createdAt = "2026-07-16T12:00:00.000Z"
): Agent {
  return { id, hasSubmittedReview, createdAt } as Agent;
}

describe("applyDiffStateChanged", () => {
  it("updates pushed stats and invalidates only committed-only stats", () => {
    const queryClient = new QueryClient();
    const includeUncommittedKey = diffStatsQueryKey("agent-1", true);
    const committedOnlyKey = diffStatsQueryKey("agent-1", false);
    const contentKey = [...agentDiffQueryKey("agent-1"), false, true] as const;

    queryClient.setQueryData(includeUncommittedKey, { added: 1, deleted: 1 });
    queryClient.setQueryData(committedOnlyKey, { added: 2, deleted: 2 });
    queryClient.setQueryData(contentKey, { files: [] });
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const pushedStats = {
      added: 3,
      deleted: 4,
      files: 2,
      computedAt: 123,
    };

    applyDiffStateChanged(queryClient, "agent-1", pushedStats);

    expect(queryClient.getQueryData(includeUncommittedKey)).toEqual(
      pushedStats
    );
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: committedOnlyKey,
      exact: true,
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: includeUncommittedKey,
      exact: true,
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: agentDiffQueryKey("agent-1"),
    });
  });
});

describe("review submission SSE state", () => {
  it("marks the reviewer submitted when review.created arrives", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData<Agent[]>(["agents"], [agent("reviewer", false)]);

    applyReviewCreated(queryClient, "reviewer");

    expect(queryClient.getQueryData<Agent[]>(["agents"])?.[0]).toMatchObject({
      id: "reviewer",
      hasSubmittedReview: true,
    });
  });

  it("does not let a stale agent upsert reactivate a submitted review", () => {
    const current = [agent("reviewer", true)];
    const incoming = agent("reviewer", false);

    expect(applyAgentUpsert(current, incoming)[0]).toMatchObject({
      id: "reviewer",
      hasSubmittedReview: true,
    });
  });
});
